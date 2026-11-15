# Chrome Web Store listing

Copy for the store submission form. Images are in this folder.

## Name

Watched Blocked

## Summary (132 characters max)

Hide videos you've already watched on YouTube.

## Description

YouTube keeps showing you videos you've already seen. Watched Blocked hides them.

It works on the home page, the sidebar next to a video, search results, playlists, Trending and Gaming. Channel pages, your Subscriptions feed and History are left alone. You can turn those on too if you want.

Settings
• Turn it off everywhere, or only on certain pages
• Choose how much of a video counts as watched, from any progress up to 100%
• Hide watched videos, or just dim them
• Alt+Shift+W turns it on and off

The toolbar icon shows how many videos are hidden on the page you're on. Your settings sync between your devices through your browser's sync.

You need to be signed in to YouTube with watch history turned on. Watched Blocked uses the red progress bar YouTube shows under videos you've watched.

No tracking, no ads, and it doesn't collect any data.

## Category

Productivity

## Language

English

## Graphics

| File | Use |
| --- | --- |
| `../extension/icons/icon-128.png` | Store icon (128×128) |
| `screenshot-1.png` | Screenshot (1280×800) |
| `screenshot-2.png` | Screenshot (1280×800) |
| `screenshot-3.png` | Screenshot (1280×800) |
| `promo-small.png` | Small promo tile (440×280) |
| `promo-marquee.png` | Marquee promo tile (1400×560) |

## Privacy tab

**Single purpose**

Hides YouTube videos the user has already watched.

**Permission justification**

| Permission | Why |
| --- | --- |
| `storage` | Saves the user's settings and syncs them across their browsers. |
| `scripting` | When the extension is installed or updated, it adds itself to YouTube tabs that are already open, so they don't need a reload. |
| Host access to `https://www.youtube.com/*` | Reads YouTube pages to find watched videos and hide them. |

**Remote code:** No.

**Data usage:** The extension does not collect or transmit any user data. Tick none of the data categories. Certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

## Package

Run `npm run package` and upload `dist/watched-blocked-1.0.zip`.
