export const MEADOW_BRIDGE =
  '(()=>{let setup={};try{setup=JSON.parse(window.name)}catch{}const channel=String(setup.channel??"");if(setup.night===true)location.hash="#night";const send=(message)=>parent.postMessage(Object.assign({ardiaMeadow:channel},message),"*");window.webkit={messageHandlers:{meadow:{postMessage:send}}};addEventListener("message",(event)=>{const data=event.data;if(!data||data.ardiaMeadow!==channel||typeof data.night!=="boolean")return;window.meadowNight?.(data.night);});})();';

const SCENE_SCRIPT = "<script>";

export function meadowDocument(page: string): string {
  const at = page.indexOf(SCENE_SCRIPT);
  const bridge = `<script>${MEADOW_BRIDGE}</script>`;
  return at < 0 ? page : page.slice(0, at) + bridge + page.slice(at);
}

export const meadowFrameName = (channel: string, night: boolean) => JSON.stringify({ channel, night });

export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
}
