// @ts-check
import { createConfig } from '@merkaly/nest-tooling/eslint';

export default createConfig({ tsconfigRootDir: import.meta.dirname, ignores: ['tooling/**'] });
