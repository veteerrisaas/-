from pathlib import Path
from html.parser import HTMLParser
from html import escape
from zipfile import ZipFile
import csv, json, shutil

ROOT = Path(__file__).resolve().parent
ZIP = ROOT / 'instagram-gabrieltipss-2026-10-11-QsJ9Rsxm.zip'
OUT = ROOT / 'publicacoes-conta-reserva'

class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []
    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node): yield from child.walk()
    def text(self):
        return ''.join(c.text() if isinstance(c, Node) else c for c in self.children)

class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node(); self.stack = [self.root]
    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs); self.stack[-1].children.append(n)
        if tag == 'br': n.children.append('\n')
        if tag not in {'img','br','hr','meta','link','input','source','wbr','area','base','embed','param','col'}: self.stack.append(n)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)
    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i].tag == tag:
                del self.stack[i:]; break
    def handle_data(self, text): self.stack[-1].children.append(text)

OUT.mkdir(exist_ok=True)
records = []
with ZipFile(ZIP) as archive:
    assert archive.testzip() is None, 'ZIP corrompido'
    names = set(archive.namelist())
    selected = [n for n in names if n.startswith('media/') or n.startswith('your_instagram_activity/media/')]
    for name in selected:
        target = (OUT / 'originais' / name).resolve()
        if not target.is_relative_to((OUT / 'originais').resolve()): raise ValueError('Caminho inseguro no ZIP')
        if name.endswith('/'): target.mkdir(parents=True, exist_ok=True); continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(name) as src, target.open('wb') as dst: shutil.copyfileobj(src,dst)
    for category in ['posts','reels','archived_posts','stories','recently_deleted_content','other_content','profile_photos']:
        name = f'your_instagram_activity/media/{category}.html'
        if name not in names: continue
        parser = Parser(); parser.feed(archive.read(name).decode('utf-8-sig'))
        main = next((n for n in parser.root.walk() if n.tag == 'main'), None)
        if main is None: continue
        for card in [n for n in main.children if isinstance(n,Node)]:
            paths = []
            for node in card.walk():
                for key in ['src','href']:
                    p = node.attrs.get(key,'')
                    if p.startswith('media/') and p not in paths: paths.append(p)
            if not paths: continue
            caption = None; date = ''; expires = False
            for row in card.walk():
                if row.tag != 'tr': continue
                cells = [c for c in row.children if isinstance(c,Node) and c.tag in {'td','th'}]
                if len(cells)==2:
                    label = cells[0].text().strip()
                    if label == 'Legenda': caption = cells[1].text().strip()
                    if label == 'Data/hora de criação': date = cells[1].text().strip()
                    if label in {'Hora de expiração','Horário de expiração'}: expires = True
            if caption is None:
                title = next((n for n in card.children if isinstance(n,Node) and n.tag=='h2'),None)
                caption = title.text().strip() if title else ''
            if not date:
                dates = [n.text().strip() for n in card.children if isinstance(n,Node) and '_a6-o' in n.attrs.get('class','').split()]
                date = dates[-1] if dates else ''
            index = 1 + sum(r['categoria']==category for r in records)
            folder = OUT / 'publicacoes' / category / f'{index:03d}'
            folder.mkdir(parents=True,exist_ok=True)
            assets=[]; missing=[]
            for order,p in enumerate(paths,1):
                if p not in names: missing.append(p); continue
                dest=folder / f'{order:02d}_{Path(p).name}'
                shutil.copy2(OUT/'originais'/p,dest)
                assets.append(dest.relative_to(OUT).as_posix())
            (folder/'legenda.txt').write_text(caption,encoding='utf-8')
            record={'categoria':category,'numero':index,'data_original':date,'legenda':caption,'arquivos':assets,'origens':paths,'ausentes':missing,'status':'preparado para revisao','conta_destino':'a definir'}
            record['tipo_original'] = 'story' if category == 'stories' or expires else 'reel' if category == 'reels' else 'perfil' if category == 'profile_photos' else 'post'
            (folder/'metadados.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
            records.append(record)
(OUT/'catalogo.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
with (OUT/'catalogo.csv').open('w',encoding='utf-8-sig',newline='') as f:
    writer=csv.writer(f,delimiter=';'); writer.writerow(['categoria','numero','data_original','legenda','arquivos','ausentes','status'])
    for r in records: writer.writerow([r['categoria'],r['numero'],r['data_original'],r['legenda'],' | '.join(r['arquivos']),' | '.join(r['ausentes']),r['status']])
cards=[]
for r in records:
    previews=[]
    for asset in r['arquivos']:
        url=escape(asset,quote=True)
        if Path(asset).suffix.lower() in {'.jpg','.jpeg','.png','.webp'}: previews.append(f'<img loading="lazy" src="{url}" style="max-width:280px;max-height:320px">')
        elif Path(asset).suffix.lower() in {'.mp4','.mov'}: previews.append(f'<video controls preload="none" src="{url}" style="max-width:280px;max-height:320px"></video>')
        else: previews.append(f'<a href="{url}">{escape(Path(asset).name)}</a>')
    cards.append(f'<article><h2>{escape(r["categoria"])} {r["numero"]:03d}</h2><p>{escape(r["data_original"])}</p>{" ".join(previews)}<pre>{escape(r["legenda"])}</pre></article>')
(OUT/'catalogo.html').write_text('<!doctype html><meta charset="utf-8"><title>Publicações da conta reserva</title><style>body{font:16px Arial;margin:24px;background:#eee}article{background:white;padding:20px;margin:16px 0}pre{white-space:pre-wrap;font:inherit}</style><h1>Publicações para revisão</h1><p>Legendas originais preservadas. Datas, links da bio e chamadas temporais precisam de revisão antes de republicar.</p>'+''.join(cards),encoding='utf-8')
counts={c:sum(r['categoria']==c for r in records) for c in sorted(set(r['categoria'] for r in records))}
missing=sum(len(r['ausentes']) for r in records)
summary={'zip':ZIP.name,'midias_extraidas':sum(n.startswith('media/') and not n.endswith('/') for n in selected),'publicacoes':counts,'referencias_ausentes':missing}
(OUT/'resumo.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
(OUT/'LEIA-ME.txt').write_text('Abra catalogo.html para revisar as mídias e legendas.\nCada pasta em publicacoes contém mídias na ordem original, legenda.txt e metadados.json.\nOs arquivos catalogo.csv e catalogo.json relacionam todos os itens.\nAs legendas são originais: revise referências a hoje/amanhã, links e bio para a conta reserva.\nA conta destino ainda não foi definida; nenhum item foi publicado.\n',encoding='utf-8')
for r in records:
    for asset in r['arquivos']: assert (OUT/asset).is_file()
print(json.dumps(summary,ensure_ascii=False,indent=2))
