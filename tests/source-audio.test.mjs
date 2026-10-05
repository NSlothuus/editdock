import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorSession, validate} from '../src/core.ts';
const asset=(id,hasSourceAudio)=>({id,name:`${id}.mp4`,kind:'video',durationFrames:90,url:`/media/${id}`,hasSourceAudio});
const clip={id:'main',trackId:'V1',assetId:'tone',start:0,inFrame:0,duration:90};
test('V2 source audio: version gate, defaults, strict record and atomic undo',()=>{
 const v1={version:1,fps:30,name:'Legacy',revision:0,assets:[asset('tone',true)],clips:[{...clip,sourceAudio:{muted:false,gain:0.7}}]};
 const legacy=new EditorSession(v1), bytes=JSON.stringify(legacy.project);
 assert.throws(()=>legacy.execute({type:'clip.sourceAudio',id:'main',settings:{muted:true,gain:0.4}}),/V2/);
 assert.equal(JSON.stringify(legacy.project),bytes); assert.equal(legacy.canUndo,false);
 assert.equal(new EditorSession(JSON.parse(bytes)).project.clips[0].sourceAudio.gain,0.7);
 const s=new EditorSession({version:2,fps:30,name:'V2',revision:0,assets:[],clips:[]}); assert.equal(s.project.version,2);
 s.execute({type:'asset.add',asset:asset('tone',true)});
 s.execute({type:'asset.add',asset:asset('silent',false)});
 s.execute({type:'clip.add',clip});
 s.execute({type:'clip.add',clip:{...clip,id:'silent-clip',assetId:'silent',trackId:'V2'}});
 s.execute({type:'clip.sourceAudio',id:'main',settings:{muted:true,gain:0.25}});
 assert.deepEqual(s.project.clips[0].sourceAudio,{muted:true,gain:0.25});
 s.execute({type:'clip.split',id:'main',at:30,newId:'split'});
 assert.deepEqual(s.project.clips.find(c=>c.id==='split').sourceAudio,{muted:true,gain:0.25});
 s.undo(); s.undo(); assert.equal(s.project.clips[0].sourceAudio,undefined);
 s.redo(); assert.equal(s.project.clips[0].sourceAudio.gain,0.25);
 assert.deepEqual(new EditorSession(JSON.parse(JSON.stringify(s.project))).project,s.project);
 const before=JSON.stringify(s.project), canUndo=s.canUndo, canRedo=s.canRedo;
 for(const settings of [{muted:false,gain:1.01},{muted:false,gain:-0.1},{muted:0,gain:1},{muted:true,gain:NaN},{muted:false,gain:1,filter:'evil'},null]) {
   assert.throws(()=>s.execute({type:'clip.sourceAudio',id:'main',settings}));
   assert.equal(JSON.stringify(s.project),before); assert.equal(s.canUndo,canUndo); assert.equal(s.canRedo,canRedo);
 }
 for(const id of ['silent-clip','missing']) assert.throws(()=>s.execute({type:'clip.sourceAudio',id,settings:{muted:false,gain:1}}));
 for(const mutate of [p=>{p.assets[0].hasSourceAudio='yes'},p=>{delete p.assets[0].hasSourceAudio},p=>{p.clips[0].sourceAudio={muted:false,gain:2}},p=>{p.clips[1].sourceAudio={muted:false,gain:1}},p=>{p.version=4}]) {
   const forged=structuredClone(s.project); mutate(forged); assert.throws(()=>validate(forged));
 }
});
