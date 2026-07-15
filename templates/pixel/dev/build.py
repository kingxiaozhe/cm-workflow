from PIL import Image
import base64, io, json
import os
D = os.path.dirname(os.path.abspath(__file__))
ind = Image.open(D+"/sheets/roguelikeIndoor_transparent.png").convert("RGBA")
cty = Image.open(D+"/sheets/roguelikeCity_tilemap.png").convert("RGBA")
chs = Image.open(D+"/sheets/roguelikeChar_transparent.png").convert("RGBA")
def grab(im,c,r): return im.crop((c*17,r*17,c*17+16,r*17+16))
def person(body, shirt, hair, pants=(3,0)):
    t = Image.new("RGBA",(16,16),(0,0,0,0))
    for c,r in [body, pants, shirt, hair]:
        t.alpha_composite(grab(chs,c,r))
    return t
TILES = {
 "wall":grab(cty,3,19),"wall2":grab(cty,3,20),"wallB":grab(cty,3,22),
 "flr":grab(cty,6,19),"flr2":grab(cty,6,20),"flr3":grab(cty,7,19),
 "desk":grab(ind,4,3),"chairL":grab(ind,3,2),"chairR":grab(ind,2,2),
 "mon":grab(cty,34,4),"mon2":grab(cty,34,6),
 "sofaL":grab(ind,0,10),"sofaM":grab(ind,1,10),"sofaR":grab(ind,2,10),
 "rugL":grab(ind,23,5),"rugM":grab(ind,24,5),"rugM2":grab(ind,25,4),"rugR":grab(ind,26,5),
 "plant":grab(ind,16,0),"plant2":grab(ind,17,0),
 "art1":grab(ind,16,12),"art2":grab(ind,17,12),"art3":grab(ind,18,12),
 "gold":grab(ind,19,13),"mirror":grab(ind,22,17),
 "shelfA":grab(cty,10,18),"shelfB":grab(cty,12,18),"dresser":grab(cty,9,18),
 "vend":grab(cty,23,5),"fridge":grab(cty,23,6),"bin":grab(cty,12,16),"crate":grab(cty,13,16),
 "lamp":grab(cty,36,9),"lamp2":grab(cty,35,9),
 "cntL":grab(cty,19,8),"cntM":grab(cty,20,8),"cntR":grab(cty,21,8),
 "brick":grab(cty,0,11),"brick2":grab(cty,1,11),
 "wood":grab(cty,3,19),"wood2":grab(cty,4,19),"wood3":grab(cty,3,20),
 "rgA":grab(ind,12,4),"rgB":grab(ind,13,4),"rgC":grab(ind,12,5),"rgD":grab(ind,13,5),
 "chairF":grab(ind,0,2),"tblO1":grab(ind,3,0),"tblO2":grab(ind,3,1),
 "worker":person((1,0),(12,1),(20,1)),
 "codex":person((1,1),(14,5),(19,8)),
 "sleep":person((1,1),(12,0),(22,0)),
 "celA":person((1,1),(15,0),(20,0)),
 "celB":person((1,0),(13,1),(23,0)),
 "celC":person((1,0),(9,1),(21,9)),
}
COLS = 8
names = list(TILES)
rows = (len(names)+COLS-1)//COLS
atlas = Image.new("RGBA",(COLS*16, rows*16),(0,0,0,0))
tmap = {}
for i,n in enumerate(names):
    atlas.paste(TILES[n], ((i%COLS)*16,(i//COLS)*16))
    tmap[n] = [i%COLS, i//COLS]
buf = io.BytesIO(); atlas.save(buf,"PNG",optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode()
atlas.resize((COLS*16*4, rows*16*4), Image.NEAREST).save(D+"/atlas-preview.png")

html = open(D+"/template.html", encoding="utf-8").read()
html = html.replace("@B64@", b64).replace("@TMAP@", json.dumps(tmap))
out = os.path.join(D, "..", "cm-pixel.html")
open(out, "w", encoding="utf-8").write(html)
print("built", out, len(html), "bytes; atlas", len(b64))
