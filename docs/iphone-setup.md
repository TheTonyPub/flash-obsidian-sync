# flash-sync on iPhone

Use a **new empty local vault** on the iPhone. Do not copy the Mac vault's `.obsidian` directory or the plugin's `data.json`: it contains a device ID and device-specific SecretStorage references. The notes will arrive through NATS after connection.

## Install from a release or CI artifact

1. Create an empty vault in Obsidian on the iPhone, stored **On My iPhone**.
2. Download matching `main.js` and `manifest.json` from one stable release or alpha/beta prerelease. For development builds, use the matching files from its GitHub Actions artifact. Include `styles.css` only if that build provides it. Do not use GitHub's Source code zip or tar.gz as install packages.
3. Transfer the files to a folder visible in the iPhone Files app (for example, iCloud Drive or AirDrop). The iOS Files app normally hides `.obsidian`. Use a file manager that exposes hidden folders, or iSH. With iSH: run `mount -t ios . /mnt`, select the new Obsidian vault folder, then create `/mnt/.obsidian/plugins/flash-sync` and copy the downloaded files there. The plugin folder must match the manifest ID, `flash-sync`.
4. Restart Obsidian. In **Settings → Community plugins**, enable community plugins and then enable **flash-sync**.

The plugin needs Obsidian 1.11.4 or newer. The build uses browser APIs and is marked as mobile-compatible, but the iPhone runtime has not yet been tested on a physical device.

## Transfer settings

1. On the Mac, open flash-sync settings and select **Show encrypted QR**.
2. Enter a code phrase of at least 8 characters. The QR contains the vault ID, WSS address, NATS credentials, and optional S3 credentials encrypted with AES-GCM. Keep the phrase separate from the QR.
3. Scan the QR with the iPhone Camera, open the Obsidian link, enter the phrase, and select **Connect**. The plugin decrypts and imports the settings before connecting.
4. If the camera link does not reach the plugin, use **Copy transfer link** on the Mac and open it on the iPhone. You can also paste the encrypted code after `data=` into **Import settings → Paste transfer code**.

The iPhone keeps its own device ID. The QR and transfer link remain usable by anyone who also knows the phrase, so close the QR after use and do not post either item publicly. The server must provide a reachable NATS WSS endpoint, the vault's `OBS_<vaultId>_FILES` bucket, and matching vault credentials. S3 remains optional; without it, inline content syncs, while larger files do not.
