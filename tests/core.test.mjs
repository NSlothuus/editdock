import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSession, apply, emptyProject, getEffect, listEffects, projectTracks, textStyle, validate } from '../src/core.ts';
const a = { id:'red',name:'red.mp4',kind:'video',durationFrames:90,url:'/api/assets/red' };
const b = { id:'song',name:'music.m4a',kind:'audio',durationFrames:180,url:'/api/assets/song' };
const clip = { id:'c1',assetId:'red',trackId:'V1',start:0,inFrame:0,duration:90 };
const legacyEmpty = () => ({version:1,fps:30,name:'Untitled edit',revision:0,assets:[],clips:[]});
const base = () => { const s = new EditorSession(legacyEmpty()); s.execute({type:'asset.add',asset:a}); s.execute({type:'asset.add',asset:b}); s.execute({type:'clip.add',clip}); return s; };
test('typed commands split, trim, move, effect, undo and redo', () => {
 const s=base(); s.execute({type:'clip.split',id:'c1',at:30,newId:'c2'});
 assert.deepEqual(s.project.clips.map(c=>[c.start,c.inFrame,c.duration]), [[0,0,30],[30,30,60]]);
 s.execute({type:'clip.trim',id:'c2',edge:'start',frames:5});
 s.execute({type:'clip.move',id:'c2',start:40,trackId:'V2'});
 s.execute({type:'clip.effect',id:'c2',effect:'mono'});
 assert.equal(s.project.clips[1].effect,'mono'); assert.equal(s.project.clips[1].start,40);
 s.undo(); assert.equal(s.project.clips[1].effect,undefined); s.redo(); assert.equal(s.project.clips[1].effect,'mono');
 assert.equal(getEffect('mono').exportFilter,'colorchannelmixer=rr=.2126:rg=.7152:rb=.0722:gr=.2126:gg=.7152:gb=.0722:br=.2126:bg=.7152:bb=.0722');
 assert.deepEqual(listEffects().map(e => [e.id,e.name,e.previewCSS]), [
  ['mono','Monochrome','grayscale(1)'],
  ['vivid','Vivid','saturate(1.8)'],
  ['contrast','High contrast','contrast(1.35)'],
  ['sepia','Sepia','sepia(1)']
 ]);
});
test('built-in presets are undoable and unsupported filter expressions never become project data', () => {
 const s=base();
 for (const effect of ['vivid','contrast','sepia']) {
  s.execute({type:'clip.effect',id:'c1',effect});
  assert.equal(new EditorSession(JSON.parse(JSON.stringify(s.project))).project.clips[0].effect,effect);
  s.undo(); assert.notEqual(s.project.clips[0].effect,effect);
  s.redo(); assert.equal(s.project.clips[0].effect,effect);
 }
 const before=JSON.stringify(s.project);
 assert.throws(()=>s.execute({type:'clip.effect',id:'c1',effect:'eq=contrast=1000'}),/Invalid clip/);
 assert.equal(JSON.stringify(s.project),before);
 const forged=structuredClone(s.project); forged.clips[0].effect='colorchannelmixer=rr=0';
 assert.throws(()=>validate(forged),/Invalid clip/);
});

test('legacy layouts remain loadable; bounded tracks add, undo, save and reject malformed data atomically', () => {
 const s=base(), legacy=structuredClone(s.project);
 assert.equal(legacy.tracks,undefined);
 assert.deepEqual(projectTracks(legacy).map(t=>t.id),['V1','V2','T1','A1']);
 for (const kind of ['video','title','audio']) s.execute({type:'track.add',kind});
 assert.deepEqual(projectTracks(s.project).map(t=>t.id),['V1','V2','V3','T1','T2','A1','A2']);
 s.execute({type:'clip.add',clip:{...clip,id:'overlay',trackId:'V3'}});
 s.execute({type:'clip.add',clip:{id:'subtitle',trackId:'T2',text:'Another title',start:0,inFrame:0,duration:60}});
 s.execute({type:'clip.add',clip:{id:'song-two',trackId:'A2',assetId:'song',start:0,inFrame:0,duration:90}});
 assert.deepEqual(new EditorSession(JSON.parse(JSON.stringify(s.project))).project,s.project);
 const before=JSON.stringify(s.project);
 for (const forged of [
  {...s.project,tracks:[...s.project.tracks].reverse()},
  {...s.project,tracks:[...s.project.tracks,{id:'V4',kind:'video',label:'VIDEO 4'}]},
  {...s.project,tracks:[...s.project.tracks.slice(0,-1),{id:'A2',kind:'audio',label:'<script>'}]},
  {...s.project,tracks:null},
  {...s.project,tracks:[]},
  {...s.project,tracks:[...s.project.tracks,{id:'X9',kind:'video',label:'bad'}]}
 ]) assert.throws(()=>validate(forged),/Invalid tracks/);
 assert.throws(()=>s.execute({type:'track.add',kind:'subtitle'}),/Invalid track kind/);
 assert.equal(JSON.stringify(s.project),before);
 s.undo(); assert.equal(s.project.clips.some(c=>c.id==='song-two'),false);
 s.undo(); assert.equal(s.project.clips.some(c=>c.id==='subtitle'),false);
 s.undo(); assert.equal(s.project.clips.some(c=>c.id==='overlay'),false);
 s.undo(); assert.equal(s.project.tracks.some(t=>t.id==='A2'),false);
 s.redo(); assert.equal(s.project.tracks.some(t=>t.id==='A2'),true);
 const limited=new EditorSession(legacy);
 for (let i=2;i<8;i++) limited.execute({type:'track.add',kind:'video'});
 const stable=JSON.stringify(limited.project);
 assert.throws(()=>limited.execute({type:'track.add',kind:'video'}),/Track limit/);
 assert.equal(JSON.stringify(limited.project),stable);
 const bad=structuredClone(limited.project); bad.clips[0].trackId='V9'; assert.throws(()=>validate(bad),/Invalid clip/);
});

test('invalid commands and projects never mutate previous revision', () => {
 const s=base(); const before=JSON.stringify(s.project);
 for(const command of [
   {type:'clip.trim',id:'c1',edge:'end',frames:90},
   {type:'clip.split',id:'c1',at:0,newId:'other'},
   {type:'clip.add',clip:{...clip,id:'duplicate'}},
   {type:'clip.effect',id:'c1',effect:'unknown'},
   {type:'clip.move',id:'c1',start:-1,trackId:'V2'},
   {type:'clip.add',clip:{...clip,id:'missing',assetId:'absent',trackId:'V2'}}
 ]) { assert.throws(()=>s.execute(command)); assert.equal(JSON.stringify(s.project), before); }
 const portable = structuredClone(s.project); portable.assets[0].url='https://media.example/signed.mp4'; assert.doesNotThrow(()=>validate(portable));
 const corrupt = structuredClone(s.project); corrupt.assets[0].url='javascript:alert(1)'; assert.throws(()=>validate(corrupt));
 const poster = structuredClone(s.project); poster.assets[0].posterUrl='/api/posters/red.jpg'; assert.doesNotThrow(()=>validate(poster));
 poster.assets[0].posterUrl='javascript:alert(1)'; assert.throws(()=>validate(poster));
 const audioPoster = structuredClone(s.project); audioPoster.assets[1].posterUrl='/api/posters/song.jpg'; assert.throws(()=>validate(audioPoster));
 assert.equal(apply(legacyEmpty(),{type:'asset.add',asset:a}).revision,1);
});
test('existing title text edits validate, undo/redo, and survive serialization without touching failed revisions', () => {
 const s=base();
 s.execute({type:'clip.add',clip:{id:'t1',trackId:'T1',text:'First title',start:0,inFrame:0,duration:90}});
 s.execute({type:'clip.text',id:'t1',text:'Revised & <title> "today"'});
 assert.equal(s.project.clips.find(c=>c.id==='t1').text,'Revised & <title> "today"');
 const serialized=JSON.parse(JSON.stringify(s.project));
 assert.equal(new EditorSession(serialized).project.clips.find(c=>c.id==='t1').text,'Revised & <title> "today"');
 s.undo(); assert.equal(s.project.clips.find(c=>c.id==='t1').text,'First title');
 s.redo(); assert.equal(s.project.clips.find(c=>c.id==='t1').text,'Revised & <title> "today"');
 const before=JSON.stringify(s.project), revision=s.project.revision;
 for (const command of [
  {type:'clip.text',id:'c1',text:'Wrong kind'},
  {type:'clip.text',id:'missing',text:'Unknown'},
  {type:'clip.text',id:'t1',text:''},
  {type:'clip.text',id:'t1',text:'  '},
  {type:'clip.text',id:'t1',text:'x'.repeat(101)},
  {type:'clip.text',id:'t1',text:42}
 ]) { assert.throws(()=>s.execute(command)); assert.equal(JSON.stringify(s.project),before); assert.equal(s.project.revision,revision); }
 s.undo(); assert.equal(s.project.clips.find(c=>c.id==='t1').text,'First title');
});
test('manual caption role is explicit, legacy titles remain unchanged, and malformed roles reject atomically', () => {
 const s=base();
 s.execute({type:'clip.add',clip:{id:'legacy-title',trackId:'T1',text:'Legacy title',start:0,inFrame:0,duration:20}});
 s.execute({type:'clip.add',clip:{id:'cue-1',trackId:'T1',role:'caption',text:'First cue',start:30,inFrame:0,duration:30}});
 s.execute({type:'clip.add',clip:{id:'cue-2',trackId:'T1',role:'caption',text:'Second cue',start:70,inFrame:0,duration:20}});
 s.execute({type:'clip.text',id:'cue-1',text:'Corrected cue'});
 s.execute({type:'clip.resize',id:'cue-1',edge:'end',delta:-10});
 s.execute({type:'clip.move',id:'cue-2',start:60,trackId:'T1'});
 assert.deepEqual(new EditorSession(JSON.parse(JSON.stringify(s.project))).project.clips.filter(c=>c.trackId==='T1').map(c=>[c.role,c.text,c.start,c.duration]),
   [[undefined,'Legacy title',0,20],['caption','Corrected cue',30,20],['caption','Second cue',60,20]]);
 s.undo(); assert.equal(s.project.clips.find(c=>c.id==='cue-2').start,70);
 s.undo(); assert.equal(s.project.clips.find(c=>c.id==='cue-1').duration,30);
 s.undo(); assert.equal(s.project.clips.find(c=>c.id==='cue-1').text,'First cue');
 s.redo(); assert.equal(s.project.clips.find(c=>c.id==='cue-1').text,'Corrected cue');
 const before=JSON.stringify(s.project);
 for (const role of [null,'subtitle','CAPTION',0,{},false]) {
   const forged=structuredClone(s.project); forged.clips.find(c=>c.id==='cue-1').role=role;
   assert.throws(()=>validate(forged),/Invalid title/);
   assert.throws(()=>s.execute({type:'clip.add',clip:{id:'bad-role',trackId:'T1',role,text:'bad',start:100,inFrame:0,duration:10}}));
   assert.equal(JSON.stringify(s.project),before);
 }
 const media=structuredClone(s.project); media.clips[0].role='caption'; assert.throws(()=>validate(media),/Invalid media clip/);
 assert.equal(s.project.clips.find(c=>c.id==='legacy-title').role,undefined);
});
test('fixed text style validates whole records on title lanes, defaults legacy clips and undoes atomically', () => {
 const s=base();
 s.execute({type:'clip.add',clip:{id:'heading',trackId:'T1',text:'LEGACY',start:0,inFrame:0,duration:20}});
 s.execute({type:'clip.add',clip:{id:'cue',trackId:'T1',role:'caption',text:'CC',start:30,inFrame:0,duration:20,style:{palette:'white',size:'small'}}});
 assert.deepEqual(textStyle(s.project.clips.find(c=>c.id==='heading')),{color:{label:'White on dark',css:'#ffffff',ffmpeg:'0xFFFFFF'},pixels:48});
 assert.equal(textStyle(s.project.clips.find(c=>c.id==='cue')).pixels,26);
 s.execute({type:'clip.style',id:'heading',style:{palette:'warm',size:'large'}});
 assert.deepEqual(textStyle(s.project.clips.find(c=>c.id==='heading')),{color:{label:'Warm yellow on dark',css:'#ffe082',ffmpeg:'0xFFE082'},pixels:60});
 assert.deepEqual(new EditorSession(JSON.parse(JSON.stringify(s.project))).project,s.project);
 s.undo(); assert.equal(s.project.clips.find(c=>c.id==='heading').style,undefined);
 s.redo(); assert.deepEqual(s.project.clips.find(c=>c.id==='heading').style,{palette:'warm',size:'large'});
 s.execute({type:'clip.style',id:'cue',style:null});
 assert.equal(s.project.clips.find(c=>c.id==='cue').style,undefined);
 assert.equal(textStyle(s.project.clips.find(c=>c.id==='cue')).pixels,32);
 s.undo(); assert.deepEqual(s.project.clips.find(c=>c.id==='cue').style,{palette:'white',size:'small'});
 const before=JSON.stringify(s.project), canUndo=s.canUndo, canRedo=s.canRedo;
 for (const style of [{},[],{palette:'white'}, {size:'small'}, {palette:'red',size:'large'}, {palette:'white',size:'999px'}, {palette:'white',size:'small',fontfile:'/private.ttf'}, {palette:'white',size:3}, 'fontcolor=red']) {
  const forged=structuredClone(s.project); forged.clips.find(c=>c.id==='heading').style=style;
  assert.throws(()=>validate(forged),/Invalid title/);
  assert.throws(()=>s.execute({type:'clip.style',id:'heading',style}),/Invalid title style/);
  assert.equal(JSON.stringify(s.project),before); assert.equal(s.canUndo,canUndo); assert.equal(s.canRedo,canRedo);
 }
 for (const target of ['c1','missing']) {
  assert.throws(()=>s.execute({type:'clip.style',id:target,style:{palette:'warm',size:'small'}}));
  assert.equal(JSON.stringify(s.project),before);
 }
 for (const kind of ['V1','A1']) {
  const forged=structuredClone(s.project);
  if (kind==='A1') forged.clips.push({id:'music',trackId:'A1',assetId:'song',start:0,inFrame:0,duration:20});
  forged.clips.find(c=>c.trackId===kind).style={palette:'warm',size:'medium'};
  assert.throws(()=>validate(forged),/Invalid media clip/);
 }
 assert.throws(()=>s.execute({type:'clip.add',clip:{id:'bad',trackId:'T1',text:'bad',start:60,inFrame:0,duration:10,style:{palette:'white',size:'small',font:'x'}}}),/Invalid title/);
 assert.equal(JSON.stringify(s.project),before);
});
test('clip edges resize against source bounds and overlap without mutating on failure', () => {
 const s=base();
 s.execute({type:'clip.trim',id:'c1',edge:'start',frames:15});
 s.execute({type:'clip.resize',id:'c1',edge:'start',delta:-10});
 assert.deepEqual([s.project.clips[0].start,s.project.clips[0].inFrame,s.project.clips[0].duration],[5,5,85]);
 const before=JSON.stringify(s.project);
 assert.throws(()=>s.execute({type:'clip.resize',id:'c1',edge:'end',delta:1}));
 assert.equal(JSON.stringify(s.project),before);
 s.undo();
 assert.deepEqual([s.project.clips[0].start,s.project.clips[0].duration],[15,75]);
 s.execute({type:'clip.trim',id:'c1',edge:'end',frames:15});
 s.execute({type:'clip.resize',id:'c1',edge:'end',delta:10});
 assert.equal(s.project.clips[0].duration,70);
 s.execute({type:'clip.split',id:'c1',at:45,newId:'c2'});
 const split=JSON.stringify(s.project);
 assert.throws(()=>s.execute({type:'clip.resize',id:'c1',edge:'end',delta:1}));
 assert.equal(JSON.stringify(s.project),split);
});
