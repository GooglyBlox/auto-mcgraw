const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const runBrowser = require('./browser-harness.cjs');
const root = path.join(__dirname, '..');
const scripts = [
  `window.AutoMcGraw = {
    settings: { DEFAULTS: {pauseBeforeSubmit: true}, subscribe() {}, async load() {return this.DEFAULTS;} },
    automation: {create(config) { window.adapter = config; return {isRunning(){return false;}};}},
    toolbar: {create() {return {render(){}, element: document.createElement('div')};}, keepMounted(){}}, dom: {}
  };`,
  fs.readFileSync(path.join(root, 'content/mhe/text.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'background/prompt.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'content/ezto/main.js'), 'utf8'),
];
const body = `<div class="question">Select three example properties.</div>
<div class="answers-wrap multiple-response"><div class="answers--mr">
<label><input type="checkbox" checked>Example A</label>
<label><input type="checkbox">Example B</label>
<label><input type="checkbox" checked>Example C</label>
<label><input type="checkbox">Example D</label>
</div></div><input id="unrelated" type="checkbox" checked>`;
const harness = `
 const assert=(v,m)=>{if(!v)throw Error(m);};
 let asked=null, stopped=null, manual=false, waited=false;
 let answer=['Example B','Example C','Example D'];
 const run={
   stop(message){stopped=message;},
   async ask(question){asked=question; return {answer};},
   async pauseForManualAnswer(){manual=true;},
   async waitForUser(){waited=true;},
   async delay(){throw Error('Must not navigate while pauseBeforeSubmit is enabled');}
 };
`;
test('EZTO detects multiple-select and replaces previous selections without navigating', () => runBrowser(body, scripts, harness + `
 await adapter.step(run);
 assert(asked?.type==='multiple_select', 'Multiple-select must be recognized: '+stopped);
 assert(JSON.stringify(asked.options)===JSON.stringify(['Example A','Example B','Example C','Example D']), 'Options must be checkbox labels');
 assert(AutoMcGraw.prompt.build(asked).includes('EVERY correct option'), 'Prompt must request all selections');
 assert(JSON.stringify([...document.querySelectorAll('.answers-wrap input')].map(x=>x.checked))==='[false,true,true,true]', 'Exact desired checkbox state');
 assert(document.getElementById('unrelated').checked, 'Unrelated checkbox must be untouched');
 assert(waited && !manual && !stopped, 'Successful selection must wait for user');
`));
test('EZTO reads associated and accessible checkbox labels and ignores hidden controls', () => runBrowser(`
 <div class="question">Choose example options.</div>
 <div class="answers-wrap multiple-choice">
 <input type="checkbox" id="first"><label for="first">Example A</label>
 <input type="checkbox" aria-labelledby="second"><span id="second">Example B</span>
 <input type="checkbox" aria-label="Example C">
 <div hidden><label><input type="checkbox">Hidden choice</label></div>
 </div>`, scripts, harness + `
 answer=['Example A','Example C'];
 await adapter.step(run);
 assert(asked.type==='multiple_select', 'Checkboxes take priority over multiple-choice wrapper');
 assert(JSON.stringify(asked.options)==='["Example A","Example B","Example C"]', 'All supported label associations');
 assert(waited && !manual, 'Selections must succeed');
`));
test('EZTO preserves single-choice selection', () => runBrowser(`
 <div class="question">Choose one example.</div>
 <div class="answers-wrap multiple-choice"><div class="answers--mc">
 <label class="answer__label--mc"><input type="radio" name="choice" checked>Example A</label>
 <label class="answer__label--mc"><input type="radio" name="choice">Example B</label>
 </div></div>`, scripts, harness + `
 answer=['Example B']; await adapter.step(run);
 assert(asked.type==='multiple_choice', 'Radio question type unchanged');
 assert(document.querySelectorAll('input')[1].checked && waited, 'Radio answer selected');
`));
test('EZTO pauses without changes when a required checkbox is disabled', () => runBrowser(body.replace('type="checkbox">Example B', 'type="checkbox" disabled>Example B'), scripts, harness + `
 await adapter.step(run);
 assert(manual, 'Disabled required control must pause');
 assert(JSON.stringify([...document.querySelectorAll('.answers-wrap input')].map(x=>x.checked))==='[true,false,true,false]', 'No partial selections');
`));
test('EZTO pauses without changes when a required checkbox is inside a disabled fieldset', () => runBrowser(body.replace('<label><input type="checkbox">Example B</label>', '<fieldset disabled><label><input type="checkbox">Example B</label></fieldset>'), scripts, harness + `
 await adapter.step(run);
 assert(manual && !waited && !stopped, 'Fieldset-disabled required control must request manual fallback');
 const states = [...document.querySelectorAll('.answers-wrap input')].map(x=>x.checked);
 assert(JSON.stringify(states)==='[true,false,true,false]', 'All original checked states must be preserved: '+JSON.stringify(states));
`));
test('EZTO rejects an empty reply without clearing selections', () => runBrowser(body, scripts, harness + `
 answer=[]; await adapter.step(run);
 assert(manual, 'Empty reply must pause');
 assert(JSON.stringify([...document.querySelectorAll('.answers-wrap input')].map(x=>x.checked))==='[true,false,true,false]', 'Keep current selections');
`));
test('EZTO rejects a partially unresolvable reply before clicking anything', () => runBrowser(body, scripts, harness + `
 answer=['Example B','Not an available choice'];
 await adapter.step(run);
 assert(asked?.type==='multiple_select', 'Question must be recognized');
 assert(manual, 'Unresolved answers must request manual help');
 assert(JSON.stringify([...document.querySelectorAll('.answers-wrap input')].map(x=>x.checked))==='[true,false,true,false]', 'Invalid response must not change selection');
`));
