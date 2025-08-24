# Plant Monitor (Minimal)
Frontend-Demo für einen Bodenfeuchte-Balken (0–100 %) im Dark-Monospace-Look.
Öffne lokal einfach `public/index.html`. Der Demo-Modus ist eingebaut.

## Struktur
- public/index.html – Seite
- public/assets/style.css – Styles
- public/assets/app.js – Logik (inkl. Demo-Modus)

## Später
- `/api/soil` als Serverless-Function auf Vercel (Phase B).
- Arduino postet an `/api/soil`.
ANIMATION.H:

const uint32_t animation[][4] = {
	{
		0xf008008,
		0xe00800,
		0x80080080,
		66
	},
	{
		0x9009009,
		0x900900,
		0x900900f0,
		66
	},
	{
		0xf008008,
		0x800800,
		0x800800f0,
		66
	},
	{
		0x900900a,
		0xc00c00,
		0xa0090090,
		66
	}
};