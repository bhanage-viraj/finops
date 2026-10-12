// Money is stored as integer rupiah. A float must not reach the database.

export function integerRupiahField() {
  return {
    type: Number,
    min: 0,
    validate: {
      validator(value) {
        return value == null || Number.isInteger(value);
      },
      message: '{PATH} must be a non-negative integer rupiah amount',
    },
  };
}
