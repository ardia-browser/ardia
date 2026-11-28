package com.ardia.phone

import java.util.UUID

internal object PageScrollScripts {
    private const val KEY_PLACEHOLDER = "ARDIA_CAPTURE_KEY"
    private const val SCROLL_PLACEHOLDER = "ARDIA_SCROLL_Y"

    fun newKey(): String = "ardia-scroll-capture-${UUID.randomUUID()}"

    fun script(source: String, key: String, cssY: String? = null): String =
        source.replace(KEY_PLACEHOLDER, key).replace(SCROLL_PLACEHOLDER, cssY ?: "null")

    const val ZOOMED = """(function(){return window.visualViewport&&window.visualViewport.scale>1.01?1:0;})()"""

    const val MARK = """(function(k){var t=Symbol.for(k);if(Object.prototype.hasOwnProperty.call(window,t))return 0;if(window.visualViewport&&window.visualViewport.scale>1.01)return 2;Object.defineProperty(window,t,{value:{list:[]},configurable:true,enumerable:false,writable:false});return 1;})('ARDIA_CAPTURE_KEY')"""

    const val HIDE_FIXED = """(function(k){var t=Symbol.for(k);if(!Object.prototype.hasOwnProperty.call(window,t))return -1;var list=window[t].list;var roots=[document.documentElement];while(roots.length){var all=roots.pop().querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];if(e.shadowRoot)roots.push(e.shadowRoot);var p=getComputedStyle(e).position;if(p!=='fixed'&&p!=='sticky')continue;list.push([e,e.getAttribute('style')]);e.style.setProperty('transition','none','important');e.style.setProperty('opacity','0','important');}}return list.length;})('ARDIA_CAPTURE_KEY')"""

    const val SCROLL = """(function(k,y){var t=Symbol.for(k);if(!Object.prototype.hasOwnProperty.call(window,t))return -1;var se=document.scrollingElement||document.documentElement,r=document.documentElement,els=r===se?[r]:[r,se],kept=[];for(var j=0;j<els.length;j++){kept.push(els[j].getAttribute('style'));els[j].style.setProperty('scroll-behavior','auto','important');}se.scrollTop=y;for(var j=0;j<els.length;j++){if(kept[j]===null)els[j].removeAttribute('style');else els[j].setAttribute('style',kept[j]);}return Math.round(se.scrollTop);})('ARDIA_CAPTURE_KEY',ARDIA_SCROLL_Y)"""

    const val SHOW_FIXED = """(function(k,y){var t=Symbol.for(k);if(!Object.prototype.hasOwnProperty.call(window,t))return -1;var list=window[t].list,n=list.length;for(var i=0;i<n;i++){var e=list[i][0],v=list[i][1];if(v===null)e.removeAttribute('style');else e.setAttribute('style',v);}list.length=0;if(y!==null){var se=document.scrollingElement||document.documentElement,r=document.documentElement,els=r===se?[r]:[r,se],kept=[];for(var j=0;j<els.length;j++){kept.push(els[j].getAttribute('style'));els[j].style.setProperty('scroll-behavior','auto','important');}se.scrollTop=y;for(var j=0;j<els.length;j++){if(kept[j]===null)els[j].removeAttribute('style');else els[j].setAttribute('style',kept[j]);}}return n;})('ARDIA_CAPTURE_KEY',ARDIA_SCROLL_Y)"""

    const val OWNS = """(function(k){return Object.prototype.hasOwnProperty.call(window,Symbol.for(k))?1:0;})('ARDIA_CAPTURE_KEY')"""

    const val DROP = """(function(k){var t=Symbol.for(k);if(!Object.prototype.hasOwnProperty.call(window,t))return 0;delete window[t];return 1;})('ARDIA_CAPTURE_KEY')"""
}
