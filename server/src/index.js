import { createApp } from './app.js';
import { connectDb } from './config/db.js';
import { loadEnvFile, readEnv } from './config/env.js';
import { recoverStuckDocuments } from './services/documents/pipeline.js';

loadEnvFile();

let env;
try {
  env = readEnv();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

try {
  await connectDb(env.mongodbUri);
  await recoverStuckDocuments(env.ai.timeoutMs);
} catch (err) {
  console.error(`Database connection failed: ${err.message}`);
  process.exit(1);
}

const app = createApp(env);
app.listen(env.port, '0.0.0.0', () => {
  console.log(`FinOps API listening on ${env.port}`);
});
