# Renderiza el panel "ESTADO DEL SISTEMA" (arranque del bot) como imagen 9:16
# (1080x1920, vertical, pensada para el chat de Telegram en el telefono).
# Rediseno del 2026-09-24: antes eran tarjetas horizontales; ahora encabezado
# con dia y hora, una franja de indicadores y tablas (servicios, pilotos,
# umbrales vigentes, rendimiento). Fuentes de Windows (Segoe UI / Arial).
#
# Uso: python render-estado-sistema.py <entrada.json> <salida.png>
#
# entrada.json:
# { "header": { "titulo": "VIEJITOBOT", "subtitulo": "Estado del sistema",
#               "fecha": "Jueves 24 de septiembre de 2026", "hora": "01:05",
#               "zona": "CDMX", "extra": "Arranque del bot" },
#   "kpis": [ { "label": "Picks 24 h", "value": "45", "tone": "ok" }, ... ],
#   "sections": [ { "title": "Servicios",
#                   "columns": [ { "name": "Servicio", "w": 0.28 },
#                                { "name": "Estado", "w": 0.18, "align": "center" },
#                                { "name": "Detalle", "w": 0.54 } ],
#                   "rows": [ [ "Bot", { "t": "ACTIVO", "tone": "ok", "pill": true }, "cada 1 min" ] ] } ],
#   "footer": "Solo lectura ..." }
#
# Cada celda es un texto o { "t": texto, "tone": ok|warn|bad|off|info, "pill": bool }.
import sys
import json
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
MARGEN = 40

BG = (15, 23, 42)          # slate 900
PANEL = (30, 41, 59)       # slate 800
BORDE = (51, 65, 85)       # slate 700
FILA_ALT = (36, 48, 68)
TEXTO = (241, 245, 249)
TEXTO_SUAVE = (148, 163, 184)
TONOS = {
    'ok':   {'fg': (52, 211, 153), 'bg': (6, 78, 59)},
    'warn': {'fg': (250, 204, 21), 'bg': (113, 63, 18)},
    'bad':  {'fg': (248, 113, 113), 'bg': (127, 29, 29)},
    'off':  {'fg': (148, 163, 184), 'bg': (51, 65, 85)},
    'info': {'fg': (56, 189, 248), 'bg': (12, 74, 110)},
}


def fuente(nombres, tamano):
    for n in nombres:
        try:
            return ImageFont.truetype(n, tamano)
        except Exception:
            continue
    return ImageFont.load_default()


REG = ['segoeui.ttf', 'arial.ttf']
BOLD = ['segoeuib.ttf', 'arialbd.ttf']


def ancho(draw, texto, f):
    b = draw.textbbox((0, 0), texto, font=f)
    return b[2] - b[0]


def ajustar(draw, texto, f, max_w):
    """Recorta con '...' para que el texto quepa en max_w."""
    texto = str(texto)
    if ancho(draw, texto, f) <= max_w:
        return texto
    while texto and ancho(draw, texto + '...', f) > max_w:
        texto = texto[:-1]
    return (texto.rstrip() + '...') if texto else ''


def envolver(draw, texto, f, max_w, max_lineas=4):
    """Parte el texto en lineas que quepan en max_w (por palabras; una palabra mas
    ancha que la celda se corta por caracteres). Si pasa de max_lineas, la ultima acaba en '...'."""
    palabras = str(texto).split()
    lineas, actual = [], ''
    for pal in palabras:
        while ancho(draw, pal, f) > max_w and len(pal) > 1:
            k = len(pal)
            while k > 1 and ancho(draw, pal[:k], f) > max_w:
                k -= 1
            if actual:
                lineas.append(actual)
                actual = ''
            lineas.append(pal[:k])
            pal = pal[k:]
        prueba = (actual + ' ' + pal).strip()
        if actual and ancho(draw, prueba, f) > max_w:
            lineas.append(actual)
            actual = pal
        else:
            actual = prueba
    if actual:
        lineas.append(actual)
    if not lineas:
        lineas = ['']
    if len(lineas) > max_lineas:
        lineas = lineas[:max_lineas]
        lineas[-1] = ajustar(draw, lineas[-1] + '...', f, max_w) if ancho(draw, lineas[-1] + '...', f) > max_w else lineas[-1] + '...'
    return lineas


def celda(c):
    if isinstance(c, dict):
        return str(c.get('t', '')), c.get('tone'), bool(c.get('pill'))
    return str(c), None, False


def dibujar_con_wrap(dr, d, secciones, y, disponible):
    """Tablas donde TODO el texto se envuelve en varias lineas (nada se recorta con '...').
    Elige el tamano de letra mas grande (hasta tam_max) con el que todo cabe; si ni a 16 px
    cabe, quita filas del final (el llamador ya avisa en el pie cuantas se muestran)."""
    f_sec = fuente(BOLD, 28)
    ancho_tabla = W - 2 * MARGEN
    pad = 9
    tam_max = int(d.get('tam_max', 26))

    def planear(t, quitar):
        f_c, f_b = fuente(REG, t), fuente(BOLD, t)
        f_h = fuente(BOLD, max(15, t - 4))
        lh = int(t * 1.22)
        total, plan = 0, []
        for s in secciones:
            cols = s.get('columns', [])
            filas = s.get('rows', [])
            if s.get('wrap') and quitar:
                filas = filas[:max(len(filas) - quitar, 1)]
            hdr = t + 24
            alturas, celdas = [], []
            for fila in filas:
                fila_c, mx = [], 1
                for j, c in enumerate(cols):
                    w = ancho_tabla * c.get('w', 1 / max(len(cols), 1))
                    txt, tono, pill = celda(fila[j] if j < len(fila) else '')
                    if pill or not s.get('wrap'):
                        ls = [ajustar(dr, txt, f_b if (j == 0 or pill) else f_c, w - 2 * pad - (20 if pill else 0))]
                    else:
                        ls = envolver(dr, txt, f_b if j == 0 else f_c, w - 2 * pad, 3)
                    mx = max(mx, len(ls))
                    fila_c.append((ls, tono, pill))
                alturas.append(max(t + 26, mx * lh + 18))
                celdas.append(fila_c)
            alto = hdr + sum(alturas)
            total += 52 + alto + 24
            plan.append((s, cols, filas, hdr, alturas, celdas, alto))
        return total, plan, f_c, f_b, f_h, lh, t

    elegido = None
    for t in range(tam_max, 15, -1):
        total, plan, *rest = planear(t, 0)
        if total <= disponible:
            elegido = (plan, *rest)
            break
    if elegido is None:
        quitar = 1
        while True:
            total, plan, *rest = planear(16, quitar)
            if total <= disponible or quitar > 200:
                elegido = (plan, *rest)
                break
            quitar += 1
    plan, f_c, f_b, f_h, lh, t = elegido
    omitidas = sum(len(s.get('rows', [])) - len(pl[2]) for s, pl in zip(secciones, plan))
    if omitidas > 0:
        # No caben ni a 16 px: el llamador tiene que paginar antes. Antes esto pasaba en silencio.
        print(f'FILAS_OMITIDAS={omitidas}', file=sys.stderr)
    f_pill = fuente(BOLD, max(16, t - 5))

    for s, cols, filas, hdr, alturas, celdas, alto in plan:
        dr.text((MARGEN, y), s.get('title', '').upper(), font=f_sec, fill=TONOS.get(s.get('title_tone'), TONOS['info'])['fg'])
        y += 52
        dr.rounded_rectangle([MARGEN, y, W - MARGEN, y + alto], radius=14, fill=PANEL, outline=BORDE, width=1)
        xs, x = [], MARGEN
        for c in cols:
            xs.append(x)
            x += ancho_tabla * c.get('w', 1 / max(len(cols), 1))
        for c, x0 in zip(cols, xs):
            w = ancho_tabla * c.get('w', 1 / max(len(cols), 1))
            h_txt = ajustar(dr, c.get('name', '').upper(), f_h, w - 2 * pad)
            tx = x0 + pad
            if c.get('align') == 'center':
                tx = x0 + (w - ancho(dr, h_txt, f_h)) / 2
            elif c.get('align') == 'right':
                tx = x0 + w - pad - ancho(dr, h_txt, f_h)
            dr.text((tx, y + (hdr - f_h.size) / 2 - 2), h_txt, font=f_h, fill=TEXTO_SUAVE)
        dr.line([(MARGEN, y + hdr), (W - MARGEN, y + hdr)], fill=BORDE, width=1)
        ry = y + hdr
        for r, (fila_c, hr) in enumerate(zip(celdas, alturas)):
            if r % 2 == 1:
                dr.rectangle([MARGEN + 8, ry + 1, W - MARGEN - 8, ry + hr - 1], fill=FILA_ALT)
            for j, ((ls, tono, pill), c, x0) in enumerate(zip(fila_c, cols, xs)):
                w = ancho_tabla * c.get('w', 1 / max(len(cols), 1))
                col_fg = TONOS[tono]['fg'] if tono in TONOS else TEXTO
                if pill and ls[0]:
                    tw = ancho(dr, ls[0], f_pill)
                    pw, ph = tw + 26, t + 6
                    px = x0 + (w - pw) / 2 if c.get('align') == 'center' else x0 + pad
                    py = ry + (hr - ph) / 2
                    tn = TONOS.get(tono, TONOS['off'])
                    dr.rounded_rectangle([px, py, px + pw, py + ph], radius=ph / 2, fill=tn['bg'], outline=tn['fg'], width=1)
                    dr.text((px + 13, py + (ph - f_pill.size) / 2 - 2), ls[0], font=f_pill, fill=tn['fg'])
                    continue
                fnt = f_b if j == 0 else f_c
                bloque = len(ls) * lh
                ty = ry + (hr - bloque) / 2
                for k, linea in enumerate(ls):
                    tx = x0 + pad
                    if c.get('align') == 'center':
                        tx = x0 + (w - ancho(dr, linea, fnt)) / 2
                    elif c.get('align') == 'right':
                        tx = x0 + w - pad - ancho(dr, linea, fnt)
                    dr.text((tx, ty + k * lh + (lh - fnt.size) / 2 - 2), linea, font=fnt, fill=(col_fg if tono else TEXTO))
            ry += hr
        y += alto + 24
    return y


def main():
    if len(sys.argv) != 3:
        print('Uso: render-estado-sistema.py <entrada.json> <salida.png>', file=sys.stderr)
        sys.exit(1)
    with open(sys.argv[1], 'r', encoding='utf-8') as fh:
        d = json.load(fh)

    header = d.get('header', {})
    kpis = d.get('kpis', [])
    secciones = d.get('sections', [])

    img = Image.new('RGB', (W, H), color=BG)
    dr = ImageDraw.Draw(img)

    f_marca = fuente(BOLD, 24)
    f_titulo = fuente(BOLD, 50)
    f_fecha = fuente(BOLD, 34)
    f_hora = fuente(BOLD, 88)
    f_suave = fuente(REG, 26)
    f_kpi_v = fuente(BOLD, 44 if len(kpis) <= 4 else 34)  # 5-6 tarjetas: mas estrechas, letra menor para no cortar '+18.7u'
    f_kpi_l = fuente(REG, 22)
    f_sec = fuente(BOLD, 28)

    # ---------- encabezado: marca + titulo a la izquierda, dia y hora a la derecha ----------
    y = 34
    dr.text((MARGEN, y), header.get('titulo', 'VIEJITOBOT'), font=f_marca, fill=TONOS['info']['fg'])
    dr.text((MARGEN, y + 34), header.get('subtitulo', 'Estado del sistema'), font=f_titulo, fill=TEXTO)
    hora = header.get('hora', '')
    wh = ancho(dr, hora, f_hora)
    dr.text((W - MARGEN - wh, y - 6), hora, font=f_hora, fill=TEXTO)
    zona = header.get('zona', '')
    fecha = header.get('fecha', '')
    dr.text((MARGEN, y + 100), fecha, font=f_fecha, fill=TEXTO_SUAVE)
    if zona or header.get('extra'):
        linea = ' - '.join(x for x in [zona, header.get('extra', '')] if x)
        wz = ancho(dr, linea, f_suave)
        dr.text((W - MARGEN - wz, y + 96), linea, font=f_suave, fill=TEXTO_SUAVE)
    y += 158
    dr.line([(MARGEN, y), (W - MARGEN, y)], fill=BORDE, width=2)
    y += 22

    # ---------- franja de indicadores ----------
    if kpis:
        n = len(kpis)
        gap = 14
        kw = (W - 2 * MARGEN - gap * (n - 1)) / n
        kh = 112
        for i, k in enumerate(kpis):
            x0 = MARGEN + i * (kw + gap)
            dr.rounded_rectangle([x0, y, x0 + kw, y + kh], radius=14, fill=PANEL, outline=BORDE, width=1)
            tono = TONOS.get(k.get('tone') or '', None)
            color = tono['fg'] if tono else TEXTO
            v = ajustar(dr, k.get('value', ''), f_kpi_v, kw - 20)
            dr.text((x0 + kw / 2 - ancho(dr, v, f_kpi_v) / 2, y + 12), v, font=f_kpi_v, fill=color)
            lab = ajustar(dr, k.get('label', ''), f_kpi_l, kw - 16)
            dr.text((x0 + kw / 2 - ancho(dr, lab, f_kpi_l) / 2, y + 72), lab, font=f_kpi_l, fill=TEXTO_SUAVE)
        y += kh + 24

    # ---------- tablas: se calcula el alto de fila para que TODO quepa en 1920 ----------
    pie = 60
    disponible = H - y - pie
    fijo = 0
    filas_tot = 0
    for s in secciones:
        fijo += 52 + 24   # titulo de seccion + separacion
        filas_tot += 1 + len(s.get('rows', []))  # encabezado + filas
    fila_h = max(38, min(78, int((disponible - fijo) / max(filas_tot, 1))))
    # proporcional a la altura de fila (antes: fila_h - 32, que dejaba 19 px en tablas densas)
    tam = max(18, min(int(d.get('tam_max', 26)), int(fila_h * 0.56)))
    f_cel = fuente(REG, tam)
    f_cel_b = fuente(BOLD, tam)
    f_hdr = fuente(BOLD, max(17, tam - 4))
    f_pill = fuente(BOLD, max(16, tam - 5))

    if any(sec.get('wrap') for sec in secciones):
        y = dibujar_con_wrap(dr, d, secciones, y, disponible)
        secciones = []

    for s in secciones:
        dr.text((MARGEN, y), s.get('title', '').upper(), font=f_sec, fill=TONOS['info']['fg'])
        y += 52
        cols = s.get('columns', [])
        ancho_tabla = W - 2 * MARGEN
        pad = 9
        alto_tabla = fila_h * (1 + len(s.get('rows', [])))
        dr.rounded_rectangle([MARGEN, y, W - MARGEN, y + alto_tabla], radius=14, fill=PANEL, outline=BORDE, width=1)
        # encabezado de la tabla
        xs = []
        x = MARGEN
        for c in cols:
            xs.append(x)
            x += ancho_tabla * c.get('w', 1 / max(len(cols), 1))
        for c, x0 in zip(cols, xs):
            w = ancho_tabla * c.get('w', 1 / max(len(cols), 1))
            t = ajustar(dr, c.get('name', '').upper(), f_hdr, w - 2 * pad)
            tx = x0 + pad
            if c.get('align') == 'center':
                tx = x0 + (w - ancho(dr, t, f_hdr)) / 2
            dr.text((tx, y + (fila_h - f_hdr.size) / 2 - 2), t, font=f_hdr, fill=TEXTO_SUAVE)
        dr.line([(MARGEN, y + fila_h), (W - MARGEN, y + fila_h)], fill=BORDE, width=1)
        # filas
        for r, fila in enumerate(s.get('rows', [])):
            ry = y + fila_h * (r + 1)
            if r % 2 == 1:
                # con margen lateral para no invadir las esquinas redondeadas
                dr.rectangle([MARGEN + 8, ry + 1, W - MARGEN - 8, ry + fila_h - 1], fill=FILA_ALT)
            for j, (c, x0) in enumerate(zip(cols, xs)):
                w = ancho_tabla * c.get('w', 1 / max(len(cols), 1))
                txt, tono, pill = celda(fila[j] if j < len(fila) else '')
                col_fg = TONOS[tono]['fg'] if tono in TONOS else TEXTO
                fnt = f_cel_b if (j == 0 or pill) else f_cel
                if pill and txt:
                    t = ajustar(dr, txt, f_pill, w - 2 * pad - 20)
                    tw = ancho(dr, t, f_pill)
                    pw, ph = tw + 26, tam + 6
                    px = x0 + (w - pw) / 2 if c.get('align') == 'center' else x0 + pad
                    py = ry + (fila_h - ph) / 2
                    dr.rounded_rectangle([px, py, px + pw, py + ph], radius=ph / 2,
                                         fill=TONOS.get(tono, TONOS['off'])['bg'], outline=TONOS.get(tono, TONOS['off'])['fg'], width=1)
                    dr.text((px + 13, py + (ph - f_pill.size) / 2 - 2), t, font=f_pill, fill=TONOS.get(tono, TONOS['off'])['fg'])
                else:
                    t = ajustar(dr, txt, fnt, w - 2 * pad)
                    tx = x0 + pad
                    if c.get('align') == 'center':
                        tx = x0 + (w - ancho(dr, t, fnt)) / 2
                    elif c.get('align') == 'right':
                        tx = x0 + w - pad - ancho(dr, t, fnt)
                    dr.text((tx, ry + (fila_h - fnt.size) / 2 - 2), t, font=fnt, fill=(col_fg if tono else (TEXTO if j == 0 else TEXTO)))
        y += alto_tabla + 24

    # ---------- pie ----------
    pie_txt = d.get('footer', '')
    if pie_txt:
        t = ajustar(dr, pie_txt, f_suave, W - 2 * MARGEN)
        dr.text(((W - ancho(dr, t, f_suave)) / 2, H - 46), t, font=f_suave, fill=TEXTO_SUAVE)

    img.save(sys.argv[2])


if __name__ == '__main__':
    main()
