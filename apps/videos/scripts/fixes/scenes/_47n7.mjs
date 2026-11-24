export const measure = async (instance, keys) => {
  const rows = JSON.parse(await instance.eval(`const W = ac.store.getState().windowOrder[0];
return Promise.all(${JSON.stringify(keys)}.map((k) => ac.sidebarRows.measureRow(W, k).then((r) => r, () => null))).then((r) => JSON.stringify(r));`));
  const missing = keys.filter((_, i) => !rows[i]);
  if (missing.length) throw new Error(`no sidebar row for ${missing.join(", ")}`);
  return Object.fromEntries(keys.map((k, i) => [k, { x: Math.round(rows[i].x + rows[i].width / 2), y: Math.round(rows[i].y + rows[i].height / 2), ...rows[i] }]));
};

export const PRESS = `const pressAt = (r, hold, key) => move(r.x, r.y, 520).then(() => sleep(260)).then(() => { if (key) events.push({ t: Date.now(), [key]: 1 }); return press("down", "up", hold); }).then(() => sleep(900));`;
