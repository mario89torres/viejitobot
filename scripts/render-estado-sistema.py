# Renderiza el panel "ESTADO DEL SISTEMA" (arranque del bot) como imagen en
# vez de texto. Basado en el codigo que paso el usuario el 2026-09-12;
# parametrizado para leer los datos reales de bot.js (antes tenia las tres
# tarjetas hardcodeadas) via un JSON de entrada, y con fuentes de Windows
# (Segoe UI / Arial) en vez de DejaVu, que no viene instalado en esta maquina.
#
# Uso: python render-estado-sistema.py <entrada.json> <salida.png>
#
# entrada.json: { "hora": "15:31", "cards": [
#   { "title": "Bot", "status": "ACTIVO", "status_type": "active",
#     "metrics": [["Muestreo", "Cada 1 min"], ["Modelo", "shadow"], ["Auto-picks", "ON"]] },
#   ...
# ]}
import sys
import json
from PIL import Image, ImageDraw, ImageFont

def cargar_fuente(nombres, tamano):
    for nombre in nombres:
        try:
            return ImageFont.truetype(nombre, tamano)
        except Exception:
            continue
    return ImageFont.load_default()

def main():
    if len(sys.argv) != 3:
        print('Uso: render-estado-sistema.py <entrada.json> <salida.png>', file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        datos = json.load(f)

    cards_data = datos.get('cards', [])
    hora = datos.get('hora', '')

    width = 32 + len(cards_data) * 300 - 20
    height = 320
    bg_color = (15, 23, 42)      # Slate 900
    card_bg = (30, 41, 59)       # Slate 800
    card_border = (51, 65, 85)   # Slate 700

    img = Image.new('RGB', (max(width, 400), height), color=bg_color)
    draw = ImageDraw.Draw(img)

    font_title = cargar_fuente(['segoeuib.ttf', 'arialbd.ttf'], 16)
    font_header = cargar_fuente(['segoeuib.ttf', 'arialbd.ttf'], 15)
    font_badge = cargar_fuente(['segoeuib.ttf', 'arialbd.ttf'], 11)
    font_text = cargar_fuente(['segoeui.ttf', 'arial.ttf'], 13)
    font_text_bold = cargar_fuente(['segoeuib.ttf', 'arialbd.ttf'], 13)

    draw.text((32, 28), f"ESTADO DEL SISTEMA ({hora})", font=font_title, fill=(148, 163, 184))

    start_x, start_y = 32, 65
    card_w, card_h, gap = 280, 210, 20

    for i, card in enumerate(cards_data):
        x = start_x + i * (card_w + gap)
        y = start_y

        draw.rounded_rectangle([x, y, x + card_w, y + card_h], radius=12, fill=card_bg, outline=card_border, width=1)
        draw.text((x + 20, y + 20), card['title'], font=font_header, fill=(248, 250, 252))

        badge_x, badge_y = x + card_w - 90, y + 18
        badge_w, badge_h = 70, 24

        if card.get('status_type') == 'active':
            badge_bg, badge_border, badge_text_color = (5, 150, 105), (52, 211, 153), (52, 211, 153)
        elif card.get('status_type') == 'warning':
            badge_bg, badge_border, badge_text_color = (161, 98, 7), (250, 204, 21), (250, 204, 21)
        else:
            badge_bg, badge_border, badge_text_color = (71, 85, 105), (100, 116, 139), (148, 163, 184)

        draw.rounded_rectangle([badge_x, badge_y, badge_x + badge_w, badge_y + badge_h], radius=12, fill=badge_bg, outline=badge_border, width=1)
        bbox_badge = font_badge.getbbox(card['status'])
        badge_text_w = bbox_badge[2] - bbox_badge[0]
        draw.text((badge_x + (badge_w - badge_text_w) / 2, badge_y + 5), card['status'], font=font_badge, fill=badge_text_color)

        metric_y = y + 65
        for key, val in card.get('metrics', []):
            draw.text((x + 20, metric_y), key, font=font_text, fill=(148, 163, 184))

            val_color = (52, 211, 153) if val == 'ON' else ((56, 189, 248) if 'localhost' in val else (241, 245, 249))
            val_font = font_text_bold if val == 'ON' else font_text

            bbox = val_font.getbbox(val)
            val_w = bbox[2] - bbox[0]
            draw.text((x + card_w - 20 - val_w, metric_y), val, font=val_font, fill=val_color)

            metric_y += 32

    img.save(sys.argv[2])

if __name__ == '__main__':
    main()
