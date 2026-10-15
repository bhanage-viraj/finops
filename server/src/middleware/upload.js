import multer from 'multer';

function multerError(error) {
  error.status = 400;
  if (error.code === 'LIMIT_FILE_SIZE') error.message = 'That file is too large.';
  else error.message = 'The upload could not be read.';
  return error;
}

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
      next(multerError(error));
    });
  };
}

export function documentUploadSingle(maxBytes) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  });
  return (req, res, next) => {
    upload.single('file')(req, res, (error) => {
      if (!error) {
        next();
        return;
      }
      next(multerError(error));
    });
  };
}
