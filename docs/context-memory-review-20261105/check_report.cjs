'use strict';
// Local artifact UI checks only. No product, provider or QQ process is started.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {CDP}=require('../../scripts/cdp.cjs');
const here=__dirname,profile=fs.mkdtempSync(path.join(os.tmpdir(),'qq-review-html-'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0',pathToFileURL(path.join(here,'index.html')).href],{stdio:'ignore'});
let cdp;
(async()=>{
 const receipt={artifact:'index.html',model_calls:0,checks:[],containment:[],exceptions:[],screenshots:[]};
 try{
  for(let n=0;n<100&&!fs.existsSync(path.join(profile,'DevToolsActivePort'));n++)await pause(50);
  const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp=await CDP.connect(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  cdp.socket.addEventListener('message',event=>{const v=JSON.parse(event.data);if(v.method==='Runtime.exceptionThrown')receipt.exceptions.push(v.params.exceptionDetails.exception?.description||v.params.exceptionDetails.text);});
  await cdp.call('Runtime.enable');await cdp.call('Page.enable');
  for(let n=0;n<100;n++){if(await cdp.evaluate("document.querySelectorAll('#dimensions button').length===5"))break;await pause(50);}
  assert.equal(await cdp.evaluate("document.querySelectorAll('#dimensions button').length"),5);
  receipt.checks.push('Five proposed dimensions render from the embedded proposal');
  await cdp.evaluate("document.querySelector('[data-dim=\"3\"]').click()");
  assert.ok((await cdp.evaluate("document.querySelector('#dimension-detail').textContent")).includes('表达忠实与边界'));
  receipt.checks.push('Dimension selection changes its anchors and counterexample');
  await cdp.evaluate("document.querySelector('[data-tab=bench]').click();document.querySelector('[data-bench=\"隐式应用\"]').click()");
  const filtered=await cdp.evaluate("document.querySelectorAll('#benchmarks article').length");assert.ok(filtered>0&&filtered<9);
  await cdp.evaluate("document.querySelector('#bench-search').value='LongMemEval';document.querySelector('#bench-search').dispatchEvent(new Event('input'))");
  assert.equal(await cdp.evaluate("document.querySelectorAll('#benchmarks article').length"),0);
  await cdp.evaluate("document.querySelector('#bench-search').value='';document.querySelector('#bench-search').dispatchEvent(new Event('input'));document.querySelector('[data-bench=\"全部\"]').click()");
  assert.equal(await cdp.evaluate("document.querySelectorAll('#benchmarks article').length"),9);
  receipt.checks.push('Benchmark capability filters and text search combine without stale cards');
  await cdp.evaluate("document.querySelector('[data-tab=trace]').click();document.querySelector('[data-step=\"5\"]').click()");
  assert.equal(await cdp.evaluate("document.querySelector('#next-step').disabled"),true);
  receipt.checks.push('Six-step fictional walkthrough changes and bounds its navigation');
  await cdp.evaluate("document.querySelector('[data-tab=questions]').click();document.querySelector('[data-finding=\"离线评分探针复现\"]').click()");
  assert.equal(await cdp.evaluate("document.querySelectorAll('#findings article').length"),2);
  receipt.checks.push('Reproduced scoring defects remain separate from untested architecture hypotheses');
  await cdp.evaluate("document.querySelector('[data-tab=design]').click()");
  for(let n=0;n<100;n++){if(await cdp.evaluate("document.querySelector('#diagram').srcdoc.length>700000"))break;await pause(50);}
  assert.ok(await cdp.evaluate("document.querySelector('#diagram').srcdoc.includes('<svg')"));
  receipt.checks.push('The validated architecture document is embedded offline');
  const screenshot=async name=>{await pause(120);const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(here,name),Buffer.from(image.data,'base64'));receipt.screenshots.push(name);};
  for(const [width,height]of [[1440,900],[1920,1080],[390,844]]){
   await cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
   for(const tab of ['proposal','design','trace','questions','bench','plan']){
    await cdp.evaluate(`document.querySelector('[data-tab=${tab}]').click()`);await pause(50);
    const measure=await cdp.evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,active:document.querySelector('.panel:not([hidden])').id})");
    receipt.containment.push({...measure,viewport:[width,height]});assert.ok(measure.scrollWidth<=width,`${tab} overflows at ${width}`);
   }
   await cdp.evaluate("document.querySelector('[data-tab=proposal]').click();document.querySelector('[data-dim=\"0\"]').click()");
   await screenshot(`report.${width}.proposal.png`);
   if(width===1440){await cdp.evaluate("document.querySelector('[data-tab=bench]').click()");await screenshot('report.1440.bench.png');await cdp.evaluate("document.querySelector('[data-tab=design]').click()");await screenshot('report.1440.design.png');}
  }
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await cdp.evaluate("document.querySelector('[data-tab=proposal]').click();document.querySelector('#theme').click()");assert.equal(await cdp.evaluate("document.body.classList.contains('dark')"),true);await screenshot('report.1440.dark.png');
  receipt.checks.push('All six report tabs avoid horizontal page overflow at desktop and mobile widths');
  receipt.checks.push('Theme toggle renders the dark report');
  assert.equal(receipt.exceptions.length,0);receipt.status='pass';
 }catch(error){receipt.status='failed';receipt.error=error.stack;process.exitCode=1;}
 finally{fs.writeFileSync(path.join(here,'report-ui-check.json'),JSON.stringify(receipt,null,2)+'\n');cdp?.close();chrome.kill();await pause(150);fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
 console.log(JSON.stringify({status:receipt.status,checks:receipt.checks,viewports_checked:receipt.containment.length,exceptions:receipt.exceptions,error:receipt.error},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;chrome.kill();});
