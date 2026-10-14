import { createPolicyManager } from '../../src/permissions/manager.js';
import { loadPolicy, updatePolicy } from '../../src/permissions/store.js';
const filePath=process.env.BDXA_FIXTURE_POLICY_PATH;
const policyManager=createPolicyManager(await loadPolicy(filePath),{filePath});
let token=null;
let resumeHeld=null;
process.on('message',async(msg)=>{
  try{
    if(msg.action==='claim'){
      token=msg.generation;
      await policyManager.claimRemoteGeneration(token);
      process.send({id:msg.id,ok:true});
    } else if(msg.action==='write'){
      const value=await policyManager.setCategory('browserSensitive',msg.decision,{remoteGeneration:token});
      process.send({id:msg.id,ok:true,value:value.categories.browserSensitive});
    } else if(msg.action==='hold'){
      const value=await updatePolicy(filePath,async(current)=>{
        process.send({id:msg.id,event:'locked'});
        await new Promise(resolve=>{resumeHeld=resolve});
        return {...current,categories:{...current.categories,browserSensitive:msg.decision}};
      },undefined,{remoteGeneration:token});
      process.send({id:msg.id,ok:true,value:value.categories.browserSensitive});
    } else if(msg.action==='release'){
      resumeHeld?.();
      process.send({id:msg.id,ok:true});
    }
  }catch(error){process.send({id:msg.id,ok:false,code:error?.code??'ERROR',message:String(error?.message??error)})}
});
process.send({event:'ready'});
