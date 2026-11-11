import {expect,it,vi} from 'vitest';
import {createArchilDisk,type ArchilDiskOptions} from '../../src/archil/disk.js';
it('recursively enumerates nested run evidence for preservation',async()=>{
 const listObjects=vi.fn().mockResolvedValue({objects:[{key:'research/run/roles/requirements/pages/source.md'},{key:'research/run/dataset.json'}]});
 const sdk={disks:{get:async()=>({listObjects})}} as unknown as ArchilDiskOptions['sdk'];
 const disk=createArchilDisk({sdk,diskId:'test',region:'aws-us-west-2'});
 expect(await disk.list('/research/run/')).toEqual(['/research/run/dataset.json','/research/run/roles/requirements/pages/source.md']);
 expect(listObjects).toHaveBeenCalledWith('research/run/',{recursive:true});
});
