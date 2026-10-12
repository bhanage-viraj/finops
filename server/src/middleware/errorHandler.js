// Last middleware. The client gets a short message. The stack stays on the server.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = Number(err.status || err.statusCode) || 500;
  console.error(err);
  const message = status >= 500 ? 'Something went wrong.' : err.message;
  const body = { error: message };
  if (err.issues) body.issues = err.issues;
  res.status(status).json(body);
}
