import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorSession, emptyProject, validate} from '../src/core.ts';
const video={id:'v',kind:'video',name:'v.mp4',url:'/media/v',durationFrames:90,hasSourceAudio:true};
const audio={id:'a',kind:'audio',name:'a.m4a',url:'/media/a',durationFrames:90};
const media=(id,assetId,trackId,start=0)=>({id,assetId,trackId,start,inFrame:0,duration:30});
const text=(id,trackId,start=0)=>({id,trackId,start,inFrame:0,duration:30,text:'Caption',role:'caption'});
test('V3 default, bounded generic admission, mixed clips and overlap',()=>{
 const s=new EditorSession(); assert.deepEqual(s.project, {...emptyProject(),version:3,tracks:[{id:'L1',kind:'general',label:'Track 1'}]});
 s.execute({type:'asset.add',asset:video}); s.execute({type:'asset.add',asset:audio});
 s.execute({type:'clip.add',clip:media('first','v','L1')});
 s.execute({type:'clip.add',clip:media('next','a','L1',30)});
 s.execute({type:'clip.add',clip:text('caption','L1',60)});
 assert.deepEqual(s.project.clips.map(c=>c.assetId ? s.project.assets.find(a=>a.id===c.assetId).kind : c.role),['video','audio','caption']);
 const stable=JSON.stringify(s.project),undo=s.canUndo;
 assert.throws(()=>s.execute({type:'clip.add',clip:text('collision','L1',20)}),/overlap/);
 assert.throws(()=>s.execute({type:'track.add',kind:'video'}),/generic|V3/i);
 assert.equal(JSON.stringify(s.project),stable); assert.equal(s.canUndo,undo);
 s.execute({type:'track.add'}); assert.deepEqual(s.project.tracks.map(t=>t.id),['L1','L2']);
 s.execute({type:'clip.move',id:'first',start:0,trackId:'L2'});
 for(const bad of [p=>p.tracks.push({...p.tracks[0]}),p=>p.tracks[0].label='\u0000',p=>p.tracks[0].id='?bad',p=>p.tracks=[],p=>p.tracks[0].kind='video',p=>p.version=4]) {const p=structuredClone(s.project);bad(p); assert.throws(()=>validate(p));}
 const inert=structuredClone(s.project);inert.tracks[0].label='<style>text</style>';assert.doesNotThrow(()=>validate(inert));
 const limited=new EditorSession(); for(let n=2;n<=16;n++)limited.execute({type:'track.add'});assert.throws(()=>limited.execute({type:'track.add'}),/limit/i);
});
test('explicit V2 conversion preserves opaque data, array order and source-audio facts with exact undo',()=>{
 const old={version:2,fps:30,name:'Imported',revision:4,assets:[{...video,vendor:{x:1}}],clips:[{...media('one','v','V1'),sourceAudio:{muted:false,gain:0.4},vendor:{x:2}}],tracks:[{id:'V1',kind:'video',label:'MAIN VIDEO',vendor:{x:3}},{id:'V2',kind:'video',label:'OVERLAY'},{id:'T1',kind:'title',label:'TITLES'},{id:'A1',kind:'audio',label:'MUSIC'}],vendor:{x:4}};
 const s=new EditorSession(old),bytes=JSON.stringify(s.project);assert.equal(JSON.stringify(s.project),bytes);
 s.execute({type:'project.upgradeTracks'});assert.equal(s.project.version,3);
 assert.deepEqual(s.project.tracks.map(t=>t.id),old.tracks.map(t=>t.id));
 assert.deepEqual(s.project.tracks.map(t=>t.kind),['general','general','general','general']);
 assert.deepEqual(s.project.tracks[0].vendor,{x:3});assert.deepEqual(s.project.clips,old.clips);assert.deepEqual(s.project.assets,old.assets);
 s.undo();assert.equal(JSON.stringify(s.project),bytes);s.redo();assert.equal(s.project.version,3);
 assert.throws(()=>s.execute({type:'project.upgradeTracks'}));
 const v1={...old,version:1}; const legacy=new EditorSession(v1),prior=JSON.stringify(legacy.project);
 assert.throws(()=>legacy.execute({type:'project.upgradeTracks'}),/V1.*V2|V2.*V1/);assert.equal(JSON.stringify(legacy.project),prior);assert.equal(legacy.canUndo,false);
 assert.equal(new EditorSession(v1).project.clips[0].sourceAudio.gain,0.4);
});
