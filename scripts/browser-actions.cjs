'use strict';
// Synthetic-browser interaction helpers. These dispatch real browser input and
// never force a hidden element open or call an element's click handler directly.
const assert = require('node:assert/strict');
function elementExpression(selector,index=0){return `[...document.querySelectorAll(${JSON.stringify(selector)})].at(${index})`;}
function actions(cdp) {
  async function inspect(selector,{index=0,scroll=false,allowDisabled=false}={}) {
    return cdp.evaluate(`(async()=>{const el=${elementExpression(selector,index)};if(!el)return {ok:false,reason:'missing'};
      if(!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return {ok:false,reason:'hidden'};
      if(el.disabled&&!${allowDisabled})return {ok:false,reason:'disabled'};
      if(${scroll}){el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}
      const r=el.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth,r.right))+Math.max(0,r.left),y=Math.max(0,Math.min(innerHeight,r.bottom))+Math.max(0,r.top);
      const point={x:x/2,y:y/2},hit=document.elementFromPoint(point.x,point.y),reachable=hit&&(hit===el||el.contains(hit));
      return {ok:!!reachable,reason:reachable?'':'covered or outside viewport',point,full:r.top>=0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,rect:{top:r.top,left:r.left,bottom:r.bottom,right:r.right},viewport:{width:innerWidth,height:innerHeight},hit:hit?.id||hit?.tagName};})()`);
  }
  async function click(selector,index=0) {
    const target=await inspect(selector,{index,scroll:true});
    assert.ok(target.ok,`${selector}[${index}] must be visibly clickable: ${JSON.stringify(target)}`);
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...target.point});
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',...target.point,button:'left',clickCount:1});
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',...target.point,button:'left',clickCount:1});
    await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  }
  async function fill(selector,text,index=0) {
    await click(selector,index);
    await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    if(text)await cdp.call('Input.insertText',{text});
    else {await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});}
    assert.equal(await cdp.evaluate(`${elementExpression(selector,index)}.value`),text,`${selector} accepts browser text input`);
  }
  async function select(selector,value) {
    const target=await inspect(selector,{scroll:true});assert.ok(target.ok,`${selector} must be visible before changing selection: ${JSON.stringify(target)}`);
    // Native select popups are OS surfaces. Change only a verified visible
    // control's value; navigation and form submission still use pointer input.
    await cdp.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(![...el.options].some(o=>o.value===${JSON.stringify(value)}&&!o.disabled))throw Error('Unknown enabled option');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async function openDetails(selector) {
    if(!await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.open`))await click(`${selector} > summary`);
  }
  async function closeDetails(selector) {
    if(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.open`))await click(`${selector} > summary`);
  }
  async function composer(label='composer',{allowDisabled=false}={}) {
    for(const selector of ['#assistant-input','#assistant-send']){
      const target=await inspect(selector,{allowDisabled});assert.ok(target.ok&&target.full,`${label}: ${selector} must be fully visible without scrolling: ${JSON.stringify(target)}`);
    }
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth<=innerWidth'),true,`${label}: no horizontal overflow`);
  }
  async function assertWorkspace(name){
    for(const item of ['discussion','history','background']){
      assert.equal(await cdp.evaluate(`document.querySelector('#panel-${item}').hidden`),item!==name,`${item} panel visibility follows the selected tab`);
      assert.equal(await cdp.evaluate(`document.querySelector('#tab-${item}').getAttribute('aria-selected')`),String(item===name),`${item} tab exposes its selected state`);
    }
  }
  async function workspace(name){await click(`#tab-${name}`);await assertWorkspace(name);}
  async function key(key){const code={ArrowRight:39,ArrowLeft:37,Home:36,End:35}[key];assert.ok(code,'supported navigation key');await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code});await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});}
  return {click,fill,select,inspect,openDetails,closeDetails,composer,workspace,assertWorkspace,key};
}
module.exports={actions};
