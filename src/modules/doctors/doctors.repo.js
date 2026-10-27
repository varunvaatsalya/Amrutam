// sort key -> column + direction. keyset pagination compares (col, user_id)
const SORTS = {
  rating: { col: 'd.rating_avg', dir: 'DESC' },
  fee: { col: 'd.fee_paise', dir: 'ASC' },
  experience: { col: 'd.experience_years', dir: 'DESC' },
};

const PUBLIC_COLS = `
  d.user_id AS id, p.full_name, p.city, d.specialization, d.languages, d.experience_years,
  d.fee_paise, d.bio, d.rating_avg, d.rating_count, d.is_verified`;

function createDoctorsRepo(db) {
  return {
    async search(f) {
      const where = ['d.is_verified'];
      const params = [];
      const p = (v) => { params.push(v); return `$${params.length}`; };

      if (f.q) where.push(`(p.full_name ILIKE ${p(`%${f.q}%`)} OR d.specialization ILIKE $${params.length})`);
      if (f.specialization) where.push(`d.specialization ILIKE ${p(f.specialization)}`);
      if (f.language) where.push(`${p(f.language.toLowerCase())} = ANY(d.languages)`);
      if (f.minFee !== undefined) where.push(`d.fee_paise >= ${p(f.minFee * 100)}`);
      if (f.maxFee !== undefined) where.push(`d.fee_paise <= ${p(f.maxFee * 100)}`);
      if (f.minRating !== undefined) where.push(`d.rating_avg >= ${p(f.minRating)}`);
      if (f.city) where.push(`p.city ILIKE ${p(f.city)}`);
      if (f.availableOn) {
        // the date is an IST calendar day
        const day = p(f.availableOn);
        where.push(`EXISTS (
          SELECT 1 FROM availability_slots s
          WHERE s.doctor_id = d.user_id AND s.status = 'open' AND s.starts_at > now()
            AND s.starts_at >= (${day}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
            AND s.starts_at <  (${day}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
      }

      const sort = SORTS[f.sort] || SORTS.rating;
      if (f.cursor) {
        const op = sort.dir === 'DESC' ? '<' : '>';
        where.push(`(${sort.col}, d.user_id) ${op} (${p(f.cursor.v)}, ${p(f.cursor.id)})`);
      }

      const { rows } = await db.query(
        `SELECT ${PUBLIC_COLS}, ${sort.col} AS sort_value
         FROM doctors d JOIN profiles p ON p.user_id = d.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY ${sort.col} ${sort.dir}, d.user_id ${sort.dir}
         LIMIT ${p(f.limit + 1)}`,
        params,
      );
      return rows;
    },

    async findById(id) {
      const { rows } = await db.query(
        `SELECT ${PUBLIC_COLS} FROM doctors d JOIN profiles p ON p.user_id = d.user_id WHERE d.user_id = $1`,
        [id],
      );
      return rows[0] || null;
    },

    async update(id, fields) {
      const map = {
        specialization: 'specialization',
        languages: 'languages',
        experienceYears: 'experience_years',
        bio: 'bio',
      };
      const sets = [];
      const params = [id];
      for (const [k, col] of Object.entries(map)) {
        if (fields[k] !== undefined) {
          params.push(fields[k]);
          sets.push(`${col} = $${params.length}`);
        }
      }
      if (fields.feeInr !== undefined) {
        params.push(fields.feeInr * 100);
        sets.push(`fee_paise = $${params.length}`);
      }
      if (!sets.length) return;
      await db.query(`UPDATE doctors SET ${sets.join(', ')} WHERE user_id = $1`, params);
    },

    async setVerified(id, verified) {
      const { rowCount } = await db.query('UPDATE doctors SET is_verified = $2 WHERE user_id = $1', [id, verified]);
      return rowCount === 1;
    },
  };
}

module.exports = { createDoctorsRepo };
