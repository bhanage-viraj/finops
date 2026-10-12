import multer from 'multer';

export function documentUpload(maxBytes) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 10 },
  });
  return (req, res, next) => {
    upload.array('files', 10)(req, res, (error) => {
      if (!error) {
        next();
        return;
      }
      error.status = 400;
      if (error.code === 'LIMIT_FILE_SIZE') error.message = 'That file is too large.';
      else error.message = 'The upload could not be read.';
      next(error);
    });
  };
}
