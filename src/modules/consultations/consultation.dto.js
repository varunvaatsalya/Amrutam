// what a participant sees. PHI fields are decrypted here and nowhere else.
function toConsultationDto(row, cipher, { includePhi = true } = {}) {
  return {
    id: row.id,
    status: row.status,
    scheduledAt: row.scheduled_at,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    slotId: row.slot_id,
    reason: includePhi ? cipher.decrypt(row.reason_enc) : undefined,
    doctorNotes: includePhi ? cipher.decrypt(row.doctor_notes_enc) : undefined,
    meetingUrl: ['confirmed', 'in_progress'].includes(row.status) ? row.meeting_url : undefined,
    cancelReason: row.cancel_reason ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
  };
}

const toPaymentDto = (p) => ({
  id: p.id,
  consultationId: p.consultation_id,
  amountInr: p.amount_paise / 100,
  currency: p.currency,
  status: p.status,
  failureReason: p.failure_reason ?? undefined,
  createdAt: p.created_at,
});

module.exports = { toConsultationDto, toPaymentDto };
