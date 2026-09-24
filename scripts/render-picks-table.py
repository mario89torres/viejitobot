# Renderiza la imagen de "Unidades Hoy" (ultimos picks) para los botones de
# Telegram. Dibujada directamente con Pillow — reemplaza el screenshot con
# Playwright del dashboard real que se probo primero: mas lento (levanta
# Chromium entero), fragil (depende de que el dashboard este vivo y de que
# su HTML no cambie de selectores), y generaba imagenes de decenas de miles
# de pixeles si no se recortaba el DOM a mano.
#
# Uso: python render-picks-table.py <entrada.json> <salida.png>
#
# entrada.json: { "titulo": str, "liquidados": [...], "enJuego": [...] }
#   cada pick: {id, fecha, hora, evento, mercado, seleccion, cuota, resultado, pl}
#   "enJuego" solo aplica al heuristico en produccion (el modelo aprendido
#   nunca apuesta nada, asi que "en juego" no es una decision pendiente ahi
#   y se manda vacio) — si viene vacio, esa seccion simplemente no se dibuja.
import sys
import json
from PIL import Image, ImageDraw, ImageFont

BG = (15, 23, 42)
HEADER_BG = (30, 41, 59)
ROW_BG_A = (15, 23, 42)
ROW_BG_B = (22, 30, 50)
BORDER = (51, 65, 85)
TEXT = (241, 245, 249)
MUTED = (148, 163, 184)
GREEN = (52, 211, 153)
RED = (248, 113, 113)
CYAN = (56, 189, 248)
YELLOW = (241, 196, 15)

def cargar_fuente(nombres, tamano):
    for nombre in nombres:
        try:
            return ImageFont.truetype(nombre, tamano)
        except Exception:
            continue
    return ImageFont.load_default()

def color_pl(v):
    return GREEN if v is not None and v >= 0 else RED

def fmt_u(v):
    return f"{'+' if v >= 0 else ''}{v:.2f}u"

# Columnas compartidas por las dos tablas (liquidados y en juego). El ancho
# total se calcula a partir de estas proporciones — agregar "Hora" fue parte
# del pedido explicito del usuario (2026-09-13), igual que asegurar que
# ninguna columna se recorte: Evento y Seleccion llevan mas texto y por eso
# tienen mas ancho relativo.
#
# La ultima columna cambia segun el modo: "table" (heuristico en produccion)
# muestra P/L en unidades como siempre; "model" (aprendido, sombra —
# pedido explicito del usuario el 2026-09-13) muestra un ESTADO en vez de
# unidades, porque esos picks nunca se apuestan de verdad y lo que importa
# ahi es si la señal salio bien o mal, no cuanto dinero hubiera dado.
COLUMNAS_BASE = [
    ("#", 0.5, 'left'), ("Fecha", 0.75, 'left'), ("Hora", 0.65, 'left'),
    ("Evento", 2.6, 'left'), ("Mercado", 1.6, 'left'), ("Selección", 1.6, 'left'),
    ("Cuota", 0.65, 'right'), ("Min", 0.55, 'right'), ("Edge", 0.7, 'right'),
    ("Marcador", 0.75, 'right'), ("Resultado", 1.0, 'right'),
]

def columnas_para(modo):
    ultima = ("Estado", 1.0, 'right') if modo == 'model' else ("P/L", 0.8, 'right')
    return COLUMNAS_BASE + [ultima]

def dibujar_tabla(draw, x, y, w, filas, columnas, font_header, font_row, row_h=30):
    total_rel = sum(c[1] for c in columnas)
    anchos = [int(w * c[1] / total_rel) for c in columnas]

    draw.rectangle([x, y, x + w, y + row_h], fill=HEADER_BG)
    cx = x
    for (titulo, _, align), aw in zip(columnas, anchos):
        draw.text((cx + 10, y + (row_h - 14) // 2), titulo, font=font_header, fill=MUTED)
        cx += aw
    y += row_h

    for i, fila in enumerate(filas):
        bg = ROW_BG_A if i % 2 == 0 else ROW_BG_B
        draw.rectangle([x, y, x + w, y + row_h], fill=bg)
        cx = x
        for (texto, color), (titulo, _, align), aw in zip(fila, columnas, anchos):
            texto = str(texto)
            if align == 'right':
                bbox = font_row.getbbox(texto)
                tw = bbox[2] - bbox[0]
                draw.text((cx + aw - tw - 10, y + (row_h - 13) // 2), texto, font=font_row, fill=color)
            else:
                draw.text((cx + 10, y + (row_h - 13) // 2), texto, font=font_row, fill=color)
            cx += aw
        y += row_h
    draw.rectangle([x, y - len(filas) * row_h - row_h, x + w, y], outline=BORDER, width=1)
    return y

def filas_de(picks, modo):
    filas = []
    for p in picks:
        resultado = p.get('resultado')
        if resultado == 'win':
            res_txt, res_color = 'WIN', GREEN
        elif resultado == 'loss':
            res_txt, res_color = 'LOSS', RED
        else:
            res_txt, res_color = 'EN JUEGO', CYAN

        if modo == 'model':
            # Estado en vez de P/L: estos picks nunca se apuestan de verdad,
            # asi que lo que importa es si la señal acerto o no, no cuanto
            # dinero hubiera dado. Sin "Estable" — con solo win/loss posibles
            # aqui (nunca push), esa tercera etiqueta no tendria ningun caso
            # real que la disparara.
            if resultado == 'win':
                ultima_txt, ultima_color = 'POSITIVO', GREEN
            elif resultado == 'loss':
                ultima_txt, ultima_color = 'CRÍTICO', RED
            else:
                ultima_txt, ultima_color = '—', MUTED
        else:
            ultima_txt = fmt_u(p['pl']) if p.get('pl') is not None else '—'
            ultima_color = color_pl(p['pl']) if p.get('pl') is not None else MUTED

        minuto = p.get('minuto')
        edge = p.get('edge')
        filas.append([
            (f"#{p['id']}", MUTED),
            (p['fecha'], MUTED),
            (p.get('hora', '—'), MUTED),
            (p['evento'][:42], TEXT),
            (p['mercado'][:26], MUTED),
            (p['seleccion'][:26], YELLOW),
            (f"@{p['cuota']:.2f}", TEXT),
            (f"{minuto}'" if minuto is not None else '—', MUTED),
            (f"{edge * 100:.1f}%" if edge is not None else '—', CYAN),
            (p.get('marcador') or '—', MUTED),
            (res_txt, res_color),
            (ultima_txt, ultima_color),
        ])
    return filas

def dibujar_encabezado_institucional(draw, x, y, w, modelo, pagina, total_paginas, report_id,
                                      font_label, font_value, row_h=30):
    columnas = [("Modelo", 1.4), ("Página", 0.8), ("ID de reporte", 1.6)]
    valores = [modelo, f"{pagina}/{total_paginas}", report_id]
    total_rel = sum(c[1] for c in columnas)
    anchos = [int(w * c[1] / total_rel) for c in columnas]

    draw.rectangle([x, y, x + w, y + row_h], fill=HEADER_BG)
    cx = x
    for (titulo, _), aw in zip(columnas, anchos):
        draw.text((cx + 10, y + (row_h - 12) // 2), titulo.upper(), font=font_label, fill=MUTED)
        cx += aw
    y += row_h

    draw.rectangle([x, y, x + w, y + row_h], fill=ROW_BG_B)
    cx = x
    for valor, (_, _), aw in zip(valores, columnas, anchos):
        draw.text((cx + 10, y + (row_h - 14) // 2), str(valor), font=font_value, fill=TEXT)
        cx += aw
    y += row_h

    draw.rectangle([x, y - 2 * row_h, x + w, y], outline=BORDER, width=1)
    return y

def dibujar_stats(draw, x, y, w, stats, font_label, font_value, row_h=30):
    winrate = stats.get('winrate') or 0
    pl = stats.get('pl') or 0
    apostado = stats.get('apostado') or 0
    roi = stats.get('roi') or 0

    columnas = [("Winrate", 1.0), ("Unidades del día", 1.2), ("Apostado", 1.0), ("ROI", 1.0)]
    valores = [
        (f"{winrate:.1f}%", TEXT),
        (fmt_u(pl), color_pl(pl)),
        (f"{apostado:.2f}u", TEXT),
        (f"{'+' if roi >= 0 else ''}{roi:.1f}%", color_pl(roi)),
    ]
    total_rel = sum(c[1] for c in columnas)
    anchos = [int(w * c[1] / total_rel) for c in columnas]

    draw.rectangle([x, y, x + w, y + row_h], fill=HEADER_BG)
    cx = x
    for (titulo, _), aw in zip(columnas, anchos):
        draw.text((cx + 10, y + (row_h - 12) // 2), titulo.upper(), font=font_label, fill=MUTED)
        cx += aw
    y += row_h

    draw.rectangle([x, y, x + w, y + row_h], fill=ROW_BG_B)
    cx = x
    for (valor, color), (_, _), aw in zip(valores, columnas, anchos):
        draw.text((cx + 10, y + (row_h - 14) // 2), valor, font=font_value, fill=color)
        cx += aw
    y += row_h

    draw.rectangle([x, y - 2 * row_h, x + w, y], outline=BORDER, width=1)
    return y

def main():
    if len(sys.argv) != 3:
        print('Uso: render-picks-table.py <entrada.json> <salida.png>', file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        datos = json.load(f)

    titulo = datos.get('titulo', '')
    liquidados = datos.get('liquidados', [])
    en_juego = datos.get('enJuego', [])
    modo = datos.get('modo', 'table')
    columnas = columnas_para(modo)

    modelo_nombre = datos.get('modelo') or ('Modelo aprendido (shadow)' if modo == 'model' else 'Heurístico (producción)')
    pagina = datos.get('pagina', 1)
    total_paginas = datos.get('totalPaginas', 1)
    report_id = datos.get('reportId', '—')
    stats = datos.get('stats')

    width = 1300
    row_h = 30
    header_h = 40
    header_inst_h = row_h * 2 + 14
    stats_h = row_h * 2 + 14 if stats else 0

    liq_h = header_h + row_h * (len(liquidados) + 1) if liquidados else 0
    ej_h = header_h + row_h * (len(en_juego) + 1) if en_juego else 0
    seccion_gap = 28 if liquidados and en_juego else 0
    height = 40 + header_inst_h + stats_h + liq_h + seccion_gap + ej_h + 30

    img = Image.new('RGB', (width, max(height, 120)), color=BG)
    draw = ImageDraw.Draw(img)

    font_title = cargar_fuente(['segoeuib.ttf', 'arialbd.ttf'], 18)
    font_section = cargar_fuente(['segoeuib.ttf', 'arialbd.ttf'], 14)
    font_header = cargar_fuente(['segoeuib.ttf', 'arialbd.ttf'], 12)
    font_row = cargar_fuente(['segoeui.ttf', 'arial.ttf'], 12)
    font_inst_label = cargar_fuente(['segoeuib.ttf', 'arialbd.ttf'], 11)
    font_inst_value = cargar_fuente(['segoeui.ttf', 'arial.ttf'], 13)

    y = 20
    draw.text((20, y), titulo, font=font_title, fill=TEXT)
    y += 34

    y = dibujar_encabezado_institucional(draw, 20, y, width - 40, modelo_nombre, pagina, total_paginas,
                                          report_id, font_inst_label, font_inst_value, row_h) + 14

    if stats:
        y = dibujar_stats(draw, 20, y, width - 40, stats, font_inst_label, font_inst_value, row_h) + 14

    if liquidados:
        draw.text((20, y), f"Últimos {len(liquidados)} liquidados", font=font_section, fill=MUTED)
        y += 24
        y = dibujar_tabla(draw, 20, y, width - 40, filas_de(liquidados, modo), columnas, font_header, font_row, row_h) + seccion_gap

    if en_juego:
        draw.text((20, y), f"En juego ahora ({len(en_juego)})", font=font_section, fill=CYAN)
        y += 24
        y = dibujar_tabla(draw, 20, y, width - 40, filas_de(en_juego, modo), columnas, font_header, font_row, row_h)

    if not liquidados and not en_juego:
        draw.text((20, y), "Sin picks todavía.", font=font_row, fill=MUTED)

    img.save(sys.argv[2])

if __name__ == '__main__':
    main()
