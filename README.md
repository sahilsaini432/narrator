# Narrator

Listen to your PDFs, papers, EPUBs, web articles, and photos of printed books. Narrator keeps a library of everything you add and remembers the page (and second) you stopped at. It's a web app you install to your iPhone Home Screen (a PWA). Your PC does the speech generation with [Kokoro](https://github.com/hexgrad/kokoro), so it's free and works offline once the model is downloaded.

## Run it

```powershell
.\start.ps1
```

The first run creates a Python environment, installs dependencies, and builds the web app. Open <http://localhost:8000>.

The first time you play something, Narrator downloads the Kokoro voice model (about 350 MB) into `data\models\`. That request takes a minute. After that everything runs on your PC.

Options: `-Lan` (also listen on your Wi-Fi), `-Port 9000` (default 8000), `-Rebuild` (force a fresh build of the web app, e.g. after changing `web/`).

Requirements: Python 3.12 (3.11+ works) and Node.js 20+.

## Run it as a Windows service

To have Narrator start at boot and restart if it crashes, install it as a service with [NSSM](https://nssm.cc/). Run `.\start.ps1` once first so the Python environment and web build exist.

```powershell
.\install-service.ps1                 # localhost only (use with tailscale serve)
.\install-service.ps1 -Lan            # also reachable on your Wi-Fi
.\install-service.ps1 -Port 9000      # different port
.\install-service.ps1 -Nssm D:\tools\nssm.exe   # default: E:\nssm-2.24\win64\nssm.exe
.\install-service.ps1 -Remove         # stop and uninstall
```

It asks for Administrator rights. Logs go to `data\logs\service.log`. After changing `web/`, rebuild with `.\start.ps1 -Rebuild` (then stop it) and restart the service.

## Use it on your iPhone

The phone runs only the web app. Your PC must be on and running `start.ps1` while you listen.

**Recommended: Tailscale (free, works away from home, gives you HTTPS)**

1. Install [Tailscale](https://tailscale.com/download) on the PC and from the App Store on the iPhone, and sign in to the same account on both.
2. In Tailscale's admin console, enable **MagicDNS** and **HTTPS Certificates** (DNS page).
3. On the PC, run `.\start.ps1`, then in another terminal:
   ```powershell
   tailscale serve --bg 8000
   ```
   It prints your URL, like `https://your-pc.your-tailnet.ts.net`.
4. On the iPhone, open that URL in **Safari**, tap **Share → Add to Home Screen**.

Only devices signed in to your Tailscale account can reach that URL. Narrator has no login of its own, so don't expose it to the public internet (don't use `tailscale funnel`).

**Simple: home Wi-Fi only**

Run `.\start.ps1 -Lan` and open the `http://192.168.x.x:8000` address it prints. Playback and progress work, but iOS only allows "install to Home Screen" as a full offline-capable app over HTTPS, so Tailscale is better.

## Lock screen and background playback

Audio plays through a normal `<audio>` element and the Media Session API, so it keeps playing with the screen locked. The lock screen, Control Center, and AirPods show the book title, page, and play/pause and skip ±15 s buttons. At the end of a page it moves on to the next one by itself.

## How it works

- `server/` is FastAPI + SQLite. PDFs are read with PyMuPDF, EPUBs with ebooklib, and web pages are fetched and stripped to the article text with trafilatura (tap **Link** in the library and paste an address). **Photos** (tap **Photos**) go into a folder, which is a book whose pages are your photos: pick an existing folder or create one, then take or choose pictures. Each photo is read with RapidOCR on your PC and becomes one page, in the order added. Each PDF page (or about 2,000 characters of an EPUB or web article) is one "page".
- Each page is turned into an MP3 the first time it's needed, cached in `data\audio\`, and the next two pages are generated in the background while you listen.
- Your position saves every 5 seconds, on pause, on page change, and when the app is hidden.
- `web/` is the React app. For development: `cd web; npm run dev` (proxies `/api` to port 8000).

## Managing what's saved

- **☰** on a book (library or player) opens its pages: see each page's text (and photo), fix OCR mistakes, reorder, delete single pages, rename the book, or add more photos to a folder.
- **Storage & cleanup** (bottom of the library) shows how much space each book's audio and files use, clears cached audio (it is regenerated when played), and deletes books.

## Limits

- Photo reading works best on flat, well-lit, straight-on pages. Page numbers are dropped, but running headers and mid-sentence page breaks are read as printed.

- Scanned PDFs (images with no text layer) can't be read; there is no OCR yet.
- Web pages are a one-time snapshot. Pages that need JavaScript or a login to show their text can't be read, and addresses on your own network are blocked. Some sites (e.g. Wikipedia) refuse automated requests.
- Voices are English only. Pick one in the player: Heart, Bella, Nicole (US female), Michael, Adam (US male), Emma (UK female), George (UK male). Audio is cached per voice.
- All data lives in `data\`: back it up to keep your library.
