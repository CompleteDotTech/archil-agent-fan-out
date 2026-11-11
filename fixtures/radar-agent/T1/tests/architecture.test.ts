import { expect,it } from 'vitest';
import { existsSync } from 'node:fs';
it('establishes the research-to-app handoff',()=>{for(const path of ['docs/api.md','src/types.ts','src/app.ts','src/api/index.ts','src/ui/index.ts','src/filter/index.ts','data/research.json'])expect(existsSync(path),path).toBe(true);});
