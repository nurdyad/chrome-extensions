// Electron screen coordinates are device-independent pixels; negative display
// coordinates are valid. Restore on an attached display, otherwise primary.
function clampBounds(saved, displays, width=540, height=132) {
    const areas=displays.map(d=>d.workArea || d);
    if (!areas.length) throw Error('No displays available');
    const valid=saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
    const overlap=area=>valid?Math.max(0,Math.min(saved.x+width,area.x+area.width)-Math.max(saved.x,area.x))
        *Math.max(0,Math.min(saved.y+height,area.y+area.height)-Math.max(saved.y,area.y)):0;
    const area=[...areas].sort((a,b)=>overlap(b)-overlap(a))[0];
    const w=Math.min(width,area.width),h=Math.min(height,area.height);
    return {x:Math.round(Math.max(area.x,Math.min(valid && overlap(area)>0?saved.x:area.x+(area.width-w)/2,area.x+area.width-w))),
        y:Math.round(Math.max(area.y,Math.min(valid && overlap(area)>0?saved.y:area.y+16,area.y+area.height-h))),width:w,height:h};
}
module.exports={clampBounds};
