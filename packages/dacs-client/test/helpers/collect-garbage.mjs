// A full garbage collection without needing the --expose-gc command-line flag.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

setFlagsFromString('--expose-gc');
export const collectGarbage = runInNewContext('gc');
