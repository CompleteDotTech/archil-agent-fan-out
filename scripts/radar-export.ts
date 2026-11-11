/** Re-export a run's immutable cloud evidence, including nested role/attempt artifacts. */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {parseArgs} from 'node:util';
import {createArchilDisk} from '../src/archil/disk.js';
try{process.loadEnvFile('.env');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const {values}=parseArgs({options:{run:{type:'string'}}});
if(!values.run||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(values.run))throw new Error('Pass --run ID');
const id=values.run;
if(!process.env.ARCHIL_API_KEY||!process.env.ARCHIL_DISK_ID)throw new Error('Archil configuration missing');
const disk=createArchilDisk({apiKey:process.env.ARCHIL_API_KEY,diskId:process.env.ARCHIL_DISK_ID,region:process.env.ARCHIL_REGION||'aws-us-west-2'});
let count=0;
for(const kind of ['research','runs','delivery','spec'])for(const path of await disk.list(`/${kind}/${id}/`)){
 const content=await disk.read(path);if(content===undefined)continue;
 const destination=resolve('.swarm/radar',id,'artifacts',path.slice(1));await mkdir(dirname(destination),{recursive:true});await writeFile(destination,content);count++;
 if(path===`/research/${id}/dataset.json`)await writeFile(join('.swarm/radar',id,'dataset.json'),content);
}
console.log(`Preserved ${count} artifacts for ${id}`);
