# bdcampnaut

Automatically downloads free albums from bandcamp. Usding `Tampermonkey` and `Google Apps Scripts` for scan bandcamp download URLs.

## How to install

1. Install the extension [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo).
2. Open `Extension` menu.
3. Go to `Settings` menu.
4. Open `Utilities` menu.
5. Insert link: `https://raw.githubusercontent.com/imastarshine/bdcampnaut/refs/heads/main/bc-free-grabber.user.js` to Import URL Textarea and press `Import`.

## Deployment

1. Open [Google Apps Script](https://script.google.com/home) and create a **New project**.
2. Paste the contents of `Code.gs` into the editor.
3. At the top of `Code.gs`, replace the value of `TOKEN` with your own long random string:

```js
const TOKEN = "your-secret-token-here";
```

Keep this token private.

4. Save the project (`Ctrl + S`).
5. Click `Deploy` → `New deployment`.
6. Click the gear icon next to `Select type` and choose `Web app`.
7. Set:
   - **Execute as**: `Me`
   - **Who has access**: `Anyone`
8. Click `Deploy`, then authorize access:
   `Authorize access` → choose your Google account → `Advanced` →
   Go to `<project name>` (unsafe) → `Allow`.
9. Copy the `Web app URL` (it ends with `/exec`).

In the extension settings, enter:

- **Web App URL**: the copied `/exec` URL
- **Access token**: the same value you set as `TOKEN` in `Code.gs`

