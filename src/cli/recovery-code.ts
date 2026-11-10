/**
 * Operator: give an account a new recovery code, for someone who lost theirs.
 * They then use "Forgot password?" on the sign-in form to choose a new password.
 *
 *   node --no-warnings --import tsx src/cli/recovery-code.ts <username>
 *   (on the server: docker exec agent-desk node --no-warnings --import tsx src/cli/recovery-code.ts <username>)
 */
import { openStore } from '../store.ts';
import { createAuth, AuthError } from '../auth.ts';

const username = process.argv[2];
if (!username) { console.error('Usage: recovery-code.ts <username>'); process.exit(2); }
try {
  console.log(createAuth(openStore()).issueRecoveryCode(username));
} catch (e) {
  console.error(e instanceof AuthError ? e.message : e);
  process.exit(1);
}
