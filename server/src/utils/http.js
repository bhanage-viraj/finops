export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
