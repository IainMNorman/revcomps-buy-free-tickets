import fs from 'fs';
import path from 'path';
import type { Reporter } from '@playwright/test/reporter';

class N8nReporter implements Reporter {
  onEnd() {
    const resultPath = process.env.N8N_RESULT_PATH
      ? path.resolve(process.env.N8N_RESULT_PATH)
      : path.resolve(process.cwd(), '.n8n-result.json');
    if (!fs.existsSync(resultPath)) {
      return;
    }
    const contents = fs.readFileSync(resultPath, 'utf8').trim();
    if (contents) {
      process.stdout.write(`${contents}\n`);
    }
  }
}

export default N8nReporter;
