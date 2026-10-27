const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { AppError, conflict, notFound } = require('../../lib/errors');

const toDto = (row, cipher) => ({
  id: row.id,
  consultationId: row.consultation_id,
  doctorId: row.doctor_id,
  patientId: row.patient_id,
  medications: JSON.parse(cipher.decrypt(row.medications_enc)),
  advice: cipher.decrypt(row.advice_enc),
  pdfReady: !!row.pdf_path,
  createdAt: row.created_at,
});

function createPrescriptionsService({ db, config, cipher, queue, auditService, consultationsRepo, consultationsService }) {
  async function create(consultationId, doctorId, { medications, advice }, ctx) {
    const c = await consultationsRepo.findById(consultationId);
    if (!c || c.doctor_id !== doctorId) throw notFound('Consultation');
    if (!['in_progress', 'completed'].includes(c.status)) {
      throw conflict('Prescription can only be written during or after the consultation', 'INVALID_STATE');
    }

    let row;
    try {
      const { rows } = await db.query(
        `INSERT INTO prescriptions (consultation_id, consultation_scheduled_at, doctor_id, patient_id, medications_enc, advice_enc)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [c.id, c.scheduled_at, doctorId, c.patient_id, cipher.encrypt(JSON.stringify(medications)), cipher.encrypt(advice)],
      );
      row = rows[0];
    } catch (err) {
      if (err.code === '23505') throw conflict('Prescription already exists for this consultation', 'PRESCRIPTION_EXISTS');
      throw err;
    }

    // pdf rendering is slow-ish and not needed for the response
    await queue.enqueue('prescription.pdf', { prescriptionId: row.id }, { jobId: `rx-pdf-${row.id}` });
    await auditService.record({ ...ctx, action: 'prescription.create', resourceType: 'prescription', resourceId: row.id, metadata: { consultationId } });
    return toDto(row, cipher);
  }

  async function findByConsultation(consultationId) {
    const { rows } = await db.query('SELECT * FROM prescriptions WHERE consultation_id = $1', [consultationId]);
    return rows[0] || null;
  }

  async function getForConsultation(consultationId, user, ctx) {
    const c = await consultationsRepo.findById(consultationId);
    consultationsService.assertParticipant(c, user);
    const row = await findByConsultation(consultationId);
    if (!row) throw notFound('Prescription');
    await auditService.record({ ...ctx, action: 'prescription.read', resourceType: 'prescription', resourceId: row.id });
    return toDto(row, cipher);
  }

  async function listForPatient(patientId) {
    const { rows } = await db.query(
      'SELECT * FROM prescriptions WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 100',
      [patientId],
    );
    return rows.map((r) => toDto(r, cipher));
  }

  async function getPdfPath(prescriptionId, user, ctx) {
    const { rows } = await db.query('SELECT * FROM prescriptions WHERE id = $1', [prescriptionId]);
    const row = rows[0];
    const allowed = row && (user.role === 'admin' || row.patient_id === user.id || row.doctor_id === user.id);
    if (!allowed) throw notFound('Prescription');
    if (!row.pdf_path) throw new AppError(409, 'PDF_NOT_READY', 'PDF is still being generated, try again shortly');
    await auditService.record({ ...ctx, action: 'prescription.download', resourceType: 'prescription', resourceId: row.id });
    return path.resolve(row.pdf_path);
  }

  // background job
  async function renderPdf(prescriptionId) {
    const { rows } = await db.query(
      `SELECT rx.*, dp.full_name AS doctor_name, d.registration_no, d.specialization, pp.full_name AS patient_name
       FROM prescriptions rx
       JOIN profiles dp ON dp.user_id = rx.doctor_id
       JOIN doctors d ON d.user_id = rx.doctor_id
       JOIN profiles pp ON pp.user_id = rx.patient_id
       WHERE rx.id = $1`,
      [prescriptionId],
    );
    const rx = rows[0];
    if (!rx) return false;
    if (rx.pdf_path && fs.existsSync(rx.pdf_path)) return true;

    const dir = path.join(config.storageDir, 'prescriptions');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${rx.id}.pdf`);
    await writePdf(file, {
      ...rx,
      medications: JSON.parse(cipher.decrypt(rx.medications_enc)),
      advice: cipher.decrypt(rx.advice_enc),
    });
    await db.query('UPDATE prescriptions SET pdf_path = $2 WHERE id = $1', [rx.id, file]);
    return true;
  }

  return { create, getForConsultation, listForPatient, getPdfPath, renderPdf };
}

function writePdf(file, rx) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const out = fs.createWriteStream(file);
    out.on('finish', resolve);
    out.on('error', reject);
    doc.pipe(out);

    doc.fontSize(18).text('Amrutam - Prescription');
    doc.moveDown(0.5).fontSize(10).fillColor('#555')
      .text(`Dr. ${rx.doctor_name} (${rx.specialization}) - Reg. ${rx.registration_no}`)
      .text(`Patient: ${rx.patient_name}`)
      .text(`Date: ${new Date(rx.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`)
      .text(`Ref: ${rx.id}`);

    doc.moveDown().fillColor('#000').fontSize(13).text('Medications');
    rx.medications.forEach((m, i) => {
      doc.fontSize(11).text(`${i + 1}. ${m.name} - ${m.dosage}, ${m.frequency}, ${m.durationDays} days`);
      if (m.instructions) doc.fontSize(9).fillColor('#555').text(`   ${m.instructions}`).fillColor('#000');
    });

    if (rx.advice) {
      doc.moveDown().fontSize(13).text('Advice');
      doc.fontSize(11).text(rx.advice);
    }
    doc.end();
  });
}

module.exports = { createPrescriptionsService };
