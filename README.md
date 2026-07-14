```markdown
# Multiverse · Scryfall Researcher — Complete Architecture & Logic

**A self-contained, offline-capable Magic: The Gathering research tool powered by the Scryfall API**  
Single HTML file · No build step · IndexedDB + Cache API persistence · Real-time search

This document describes every major subsystem, data flow, caching strategy, and internal logic of the application. It is intended for DevOps architects, maintainers, or anyone needing a precise, technical understanding of how the app works.

---

## Table of Contents
1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Core Components & State Management](#core-components--state-management)
4. [User Input & Query Translation](#user-input--query-translation)
5. [API Integration & Rate Limiting](#api-integration--rate-limiting)
6. [Caching & Offline Persistence](#caching--offline-persistence)
7. [Search Engine & Display](#search-engine--display)
8. [Stop Button & Abort Control](#stop-button--abort-control)
9. [Card Detail Modal](#card-detail-modal)
10. [Developer & Debug Panels](#developer--debug-panels)
11. [Offline Database Panel](#offline-database-panel)
12. [UI Interactions & Visual Feedback](#ui-interactions--visual-feedback)
13. [Initialization & Event Wiring](#initialization--event-wiring)
14. [Deployment & Hosting](#deployment--hosting)
15. [Dependencies & External Resources](#dependencies--external-resources)

---

## Overview

The **Scryfall Researcher** is a single-page HTML application that lets users write free-form card queries (one per line) and instantly see matching Magic: The Gathering cards from the Scryfall database. It includes advanced features like:

- Intelligent translation of natural / shorthand notations into valid Scryfall search syntax.
- Full offline caching of card data and images using IndexedDB and the Cache API.
- Double‑faced card support, collector number pinning, set overrides.
- Grouped or flat results view, sticky stats bar, scroll‑to‑top, auto‑scroll.
- Developer panel for direct API endpoint testing.
- Built‑in offline database browser and management.
- Stop button to cancel long-running searches.

All logic, styling, and HTML are contained in a single file; only the Quill rich text editor is loaded from a CDN. No server‑side component is required — it can be served from any static web host.

---

## System Architecture

```

┌─────────────────────────────────────────────────────────────┐
│                       Browser (HTML/CSS/JS)                 │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Quill      │  │  Translation │  │  Search       │      │
│  │   Editor     │→ │  Engine      │→ │  Controller   │      │
│  └──────────────┘  └──────────────┘  └──────┬───────┘      │
│                                            │               │
│                          ┌─────────────────▼───────────┐   │
│                          │      Scryfall API Client     │   │
│                          │  (fetchCached, fetchSingle)  │   │
│                          └───────┬──────────┬──────────┘   │
│                                  │          │               │
│                    ┌─────────────▼──┐ ┌─────▼────────────┐ │
│                    │   IndexedDB    │ │   Cache API      │ │
│                    │  (card data,   │ │  (images)        │ │
│                    │   search cache)│ │                  │ │
│                    └────────────────┘ └──────────────────┘ │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    UI Layer                           │   │
│  │  Card Grid / Stats Bar / Modal / Dev Panel / DB Panel│   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘

```

- **Quill Editor**: Accepts user input (one query per line).  
- **Translation Engine**: Converts each line into a Scryfall‑compatible query string.  
- **Search Controller**: Orchestrates the search loop, respects stop signals, updates UI.  
- **API Client**: Fetches data from Scryfall with caching, rate‑limiting, and error handling.  
- **Storage Layer**: Two independent caches – IndexedDB for structured data, Cache API for binary images.  
- **UI Layer**: Renders cards, modals, panels, and handles all user interactions.

---

## Core Components & State Management

The entire application lives inside an immediately‑invoked function expression (`(function(){...})()`). All DOM references are stored in the `DOM` object, keyed by element ID. Global mutable state includes:

| Variable               | Purpose                                                                 |
|------------------------|-------------------------------------------------------------------------|
| `db`                   | Open IndexedDB instance.                                                |
| `searching`            | Boolean flag preventing concurrent searches.                            |
| `searchAbortController`| `AbortController` instance for the current search, enabling cancellation.|
| `rowMap`               | `Map` storing DOM rows when results are grouped by query.               |
| `globalCardIndex`      | Counter for stagger animation delays.                                   |
| `autoScroll`           | Boolean that remembers whether the user was at the bottom of the page.  |
| `modalLoadId`          | Monotonically increasing ID to prevent stale modal updates.             |
| `currentModalCardId`   | ID of the card currently shown in the modal (null when closed).         |
| `quill`                | Quill editor instance.                                                  |

Important functions and their roles:
- `translateAll()` – reads Quill text, splits lines, calls `translateLine()` for each, returns `{lines, queries}`.
- `doSearch()` – main entry point for a search, calls `searchAll()`.
- `doCustomSearch()` – uses text from the advanced panel (custom queries) instead of the editor.
- `searchAll(queries, lines, onProgress)` – iterates over queries, fetches results, builds DOM.
- `fetchCached(query, addKey)` – central API call with caching.
- `showModal(card, source)` – renders the detailed card modal.
- `makeCardElement(card, sourceLine, staggerIndex)` – creates a single card thumbnail DOM element.

---

## User Input & Query Translation

### Input Method
The Quill editor (`.ql-editor`) is the primary input. Each line is treated as a separate search query. The text can contain:
- Natural card names (e.g., `"Black Lotus"`)
- Oracle text snippets (e.g., `Search your library for a card...`)
- Shorthand notations like `add: RRRRR` (mana production)
- Explicit Scryfall syntax (`t:creature c<=WGB`)
- Double‑faced cards using `//` or `/` (e.g., `Delver of Secrets // Insectile Aberration`)
- Parenthetical set and optional collector number: `1 Ancient Den (SLD)` or `Lotus Petal (MPS) 15 *F*`
- Foil/Etched markers (`*F*`, `*E*`, `*S*`) which are ignored during translation.
- Leading numbers (deck quantities) are stripped.

### Translation Pipeline (`translateLine`)
Each non‑empty line is processed through a series of steps:

1. **`add:` shorthand**: If the line starts with `add:`, it converts the following mana symbols into an `oracle:"add {W}{U}..."` query.
2. **Trim and strip leading quantity**: `1 Black Lotus` → `Black Lotus`.
3. **Extract set and collector number from parentheses**: Looks for `(SET) number` at the end. Example:
   - `Lotus Petal (MPS) 15 *F*` → set=`MPS`, number=`15`, line reduced to `Lotus Petal`.
   - `Ancient Den (SLD)` → set=`SLD`, line reduced to `Ancient Den`.
   - The extracted set code is used later to append `set:XYZ` to the query.
4. **Remove foil/etched/showcase markers**: `*F*`, `*E*`, `*S*` are stripped.
5. **Detect double‑faced cards**: If the line contains `//` or ` / `, it’s treated as a double‑faced card name and wrapped in `(name:"..." OR oracle:"...")`.
6. **Quoted exact name**: If the line is entirely wrapped in double quotes, it becomes `name:"..."`.
7. **Fallback for plain text without Scryfall operators**: If no keyword (`t:`, `o:`, `c:`, etc.) is detected, the line is wrapped as `(name:"..." OR oracle:"...")`.
8. **Hybrid lines**: If the line contains both keywords and free text, the free text is turned into a `(name:"..." OR oracle:"...")` clause, and keyword tokens are appended as separate conditions.
9. **Append global modifiers**: The global set override (if any) and language selection are appended to every query.
10. **Append collector number**: If a number was parsed from the line, `cn:XYZ` is appended.

The result is a valid Scryfall search query string ready for the API.

### Examples

| Input (line)                            | Generated Query                                                                 |
|-----------------------------------------|---------------------------------------------------------------------------------|
| `"Black Lotus"`                         | `name:"Black Lotus"`                                                            |
| `add: RRRRR`                            | `oracle:"add {R}{R}{R}{R}{R}"`                                                 |
| `1 Ancient Den (SLD)`                   | `name:"Ancient Den" set:SLD`                                                    |
| `Lotus Petal (MPS) 15 *F*`              | `name:"Lotus Petal" set:MPS cn:15`                                              |
| `Birgi, God of Storytelling // Harnfel` | `(name:"Birgi, God of Storytelling // Harnfel" OR oracle:"Birgi, God of Storytelling // Harnfel")` |
| `t:cat c<=WGB pow>3`                    | `type:cat color<=WGB pow>3`                                                     |
| `Search your library for a card`        | `(name:"Search your library for a card" OR oracle:"Search your library for a card")` |

The generated queries are also written into the **advanced panel** (`#customQueries`) where they can be manually edited and searched via the **"search these"** button.

---

## API Integration & Rate Limiting

### Scryfall API Endpoints Used
- `GET /cards/search?q=...` – main search, respects `unique=prints`, `order`, `dir`.
- `GET /cards/:code/:number` – fetch a specific card by set and collector number.
- `GET /cards/random` – fetch a random card.
- `GET /bulk-data` – list of available bulk data files.

### `fetchCached(query, addKey)`
This is the core search function. It:
1. Constructs a cache key: `search:<query>|<addKey>`, where `addKey` encodes the current “first printing” and sort order settings.
2. Checks IndexedDB for a previously stored result. If found, logs as `📦 CACHE` and returns it immediately.
3. If not cached, builds the URL:
```

https://api.scryfall.com/cards/search?q=<encodedQuery>&unique=prints&order=released&dir=asc|desc

```
4. Fetches the data with standard headers (`Accept`, `User-Agent`).
5. On success:
   - Applies first‑printing filter (`DOM.firstPrinting.checked`) – groups by `oracle_id` or `name` and keeps only the oldest printing.
   - Stores each card object in IndexedDB (`card:<id>`).
   - Pre‑caches card images (normal and small sizes) using the Cache API.
   - Stores the entire result array in IndexedDB under the cache key.
   - Logs the API call with detailed console output (`logApi`).
6. Returns the array of cards.

**Rate Limiting**: The search loop (in `searchAll`) inserts a **1.2‑second delay** between individual queries to stay well within Scryfall’s recommended 10 requests/second and hard 2/second limit for the search endpoint. The dev panel manual fetches are not rate‑limited (used sparingly).

### Single Card Fetches (`fetchSingleCard`)
For random or set/number lookups:
- First checks IndexedDB using `getCardBySetNum` (which looks up `setnum:<set>/<number>` to find the card ID, then retrieves `card:<id>`).
- If not cached, fetches from the API, saves the card and the set‑number reference, pre‑caches images, and shows the modal.

### API Call Logging
Every API interaction (including cache hits) is logged to the browser console with:
- Full URL, status code, method, and a preview of the returned data.
- The last call is displayed in the developer panel (`#lastApiCall`).

---

## Caching & Offline Persistence

Two separate browser storage mechanisms are used, working together to provide a fast, offline‑capable experience.

### IndexedDB
**Database**: `ScryfallDB`, version 2  
**Object store**: `cards` with `keyPath: 'key'` and indexes on `timestamp` and `type`.

#### Key Schema
| Key Pattern                    | Type   | Value                                           |
|--------------------------------|--------|-------------------------------------------------|
| `card:<scryfall_id>`           | `card` | Full card JSON object from Scryfall             |
| `setnum:<set>/<collector_number>` | `setnum` | `{ cardId: <scryfall_id> }`                    |
| `search:<query>|<addKey>`      | `search`| Array of card objects (result of that search)   |

**Usage**:
- Card data is stored permanently until explicitly deleted. This allows offline browsing of previously fetched cards.
- Search results are cached so that identical queries (with same settings) load instantly.
- The offline database panel provides full CRUD‑like inspection and deletion.

**Functions**: `openDB`, `dbPut`, `dbGet`, `dbGetAll`, `dbClear`, `getCardBySetNum`, `saveCardAndRef`.

### Cache API (Images)
**Cache name**: `scryfall-images-v2`  
All card images (normal and small versions) are fetched and stored in this cache. When displaying a card image, the app first tries to retrieve it from the cache (as a blob URL) via `getCachedImageUrl`. If not present, the original URL is used and the browser’s native cache takes over.

**Pre‑caching**: After fetching card data, `preCacheCardImages` iterates over all available image URIs (including card faces) and stores them. This ensures images are available offline after the first view.

---

## Search Engine & Display

### Search Flow
1. User clicks **search** (or auto‑searches on first load).
2. `doSearch()` calls `translateAll()` to get `queries` and `lines`.
3. If no queries, the grid is cleared and shows “write something”.
4. `searchAll` is invoked with the list of queries.
5. An `AbortController` is created and stored in `searchAbortController`; a new controller replaces any previous one.
6. The card grid is reset via `resetGridForSearch()`.
7. For each query:
   - `fetchCached` is called.
   - If the **group by query** toggle is on, the cards are added to a dedicated row (`addOrUpdateQueryGroup`). Otherwise they are appended to a flat grid (`appendFlatCards`).
   - Counters and error counts are updated in the stats bar.
   - After each query (except the last), the loop waits **1200 ms** before proceeding to the next.
   - The loop checks `signal.aborted` before every fetch and after the delay, allowing a stop to abort the whole process.

### Result Display Modes
- **Flat (grid‑mixed)**: All cards from all queries are mixed into one grid. Each card element is appended with a staggered fade‑in animation.
- **Grouped by query (grid‑rows)**: Each query gets its own collapsible row with a header showing the original line, and a nested grid of cards. Rows are reused if the same line appears multiple times (via `rowMap`).

### Card Thumbnails
Each card is represented by a `div.card-thumb` containing:
- An `img` with the card art (lazy‑loaded). Initially the image has class `loading‑img` and a shimmer skeleton placeholder is shown. Once loaded, the class switches to `loaded` and the skeleton is hidden.
- The card name and set code.
- A preview of the oracle text (first 80 characters).
- A small source line label.
- Clicking the thumbnail opens the card detail modal.

The image URL is obtained asynchronously via `getImageUrlCached`, which selects the appropriate art style (normal/large/art_crop/png) and tries the Cache API first.

**Stagger animation**: Each card has an `animation-delay` proportional to `globalCardIndex * 0.04s`, creating a cascading reveal effect.

### Auto‑Scroll & Scroll‑to‑Top
- `autoScroll` is set to `true` when the user is near the bottom of the page (within 200px). When new cards are added, the last inserted element is scrolled into view with `behavior:'smooth'`.
- The sticky stats bar gains a shadow when the page is scrolled past 20px (`classList.toggle('scrolled')`).
- A fixed **scroll‑to‑top button** appears when the user has scrolled more than 400px; clicking it smoothly scrolls to the top.

---

## Stop Button & Abort Control

The **stop** button (`.stop-btn`) is only visible while a search is in progress. It calls `stopSearch()`, which:
- Calls `searchAbortController.abort()`, causing the search loop to exit gracefully.
- Sets `searching = false`, re‑enables the search button, hides the stop button, and updates the status message to “stopped”.

This mechanism ensures that long‑running searches (e.g., many queries) can be cancelled without leaving the UI in an inconsistent state.

---

## Card Detail Modal

The modal (`#cardInfoModal`) shows comprehensive card information and is reused for every card view.

### Opening the Modal
- Triggered by clicking a card thumbnail, or via the dev panel / database image grid.
- `showModal(card, source)` is called with a card object and a source label.
- A new `modalLoadId` is generated to prevent race conditions if the user quickly opens another card.

### Loading State
The modal first shows a “Loading” spinner and clears all content fields.

### Image Handling
- The card’s art style is taken from the current radio button selection.
- For double‑faced cards (except the `adventure` layout), each face is rendered in a separate container with its own image and oracle text.
- For single‑faced cards or adventure cards, a single image is displayed.
- Images are loaded from the Cache API or directly.

### Data Population
- **Oracle text**: Combined from all faces with face names.
- **Type line**, **mana cost** (with symbols rendered as `<span class="mana-symbol">`).
- **Metadata grid**: set name, collector number, rarity, artist, border, frame, CMC, colors, color identity, keywords, language, release date, reserved status, EDHREC rank.
- **Prices**: USD, USD foil, EUR, EUR foil, TIX.
- **Legalities**: Displayed for a predefined order of formats, with color coding (legal/not_legal/restricted/banned).
- **Raw JSON**: Toggleable view of the card data (with image URIs removed to keep it readable).
- **Scryfall link**: Opens the card’s page on scryfall.com.

### Closing the Modal
- Clicking the close button, pressing Escape, or clicking the dimmed overlay triggers a closing animation (`.closing` class) and then hides the modal.
- After closing, all modal content is reset to avoid stale data.

---

## Developer & Debug Panels

### Advanced Panel
- Accessible via “⚙️ advanced” toggle.
- Shows a preview of the detected lines and an editable textarea with the generated Scryfall queries.
- “search these” runs the custom queries, bypassing the main editor translation.
- “refresh” re‑translates the Quill content and updates the textarea.

### Developer Panel
- **Rate limit info**: Static display of Scryfall’s limits.
- **Fetch by set/number**: Two input fields and a fetch button that calls `fetchBySetNum`.
- **Random card**: Button that fetches a random card and opens the modal.
- **Bulk data**: Fetches `/bulk-data` and displays the list of available bulk files with sizes.
- **Endpoints list**: A visual reference of all supported endpoints.
- **Last API call**: Dynamically updated with the most recent API interaction.

### About Modal
- Simple info dialog explaining the tool, triggered by the “info” button or the footer link.

---

## Offline Database Panel

Provides direct access to the IndexedDB store.

- **Show all stored cards**: Displays a list of all entries with key, type, timestamp, and a preview.
- **Show all card images**: Renders a grid of all stored cards (using their cached images) and allows clicking to open the modal.
- **Delete all data**: Clears the IndexedDB store and also purges the image cache (`caches.delete` on the image cache name).

---

## UI Interactions & Visual Feedback

### Styling
- Dark theme with CSS custom properties.
- Subtle transitions, hover effects, and shadows.
- Animations: `fadeInUp` for cards and modal sections, `shimmer` for skeleton placeholders, `dotBounce` for loading dots.

### Responsive Design
- Media queries adjust grid columns, modal size, and layout on screens narrower than 700px.
- The scroll‑to‑top button resizes on small screens.

---

## Initialization & Event Wiring

The `init` function runs immediately after the script is parsed:

1. **Open IndexedDB**: `openDB()` resolves the `db` instance.
2. **Initialize Quill**: Set up the editor with a sample text containing various query types.
3. **Auto‑translate**: `refreshQueries()` populates the advanced panel.
4. **Auto‑search**: `setTimeout(doSearch, 600)` triggers an initial search to showcase the app.
5. **Event binding**: All buttons, toggles, and selectors are wired to their handlers.
6. **Keyboard shortcut**: Escape key closes either modal.

---

## Deployment & Hosting

- The entire application is a single static HTML file.
- No server‑side processing, no build tools, no npm dependencies.
- It can be hosted on any web server (Apache, Nginx, S3, GitHub Pages, etc.).
- All external resources (Quill CSS/JS) are loaded from Cloudflare’s CDN.
- The app works best over HTTPS because service workers and the Cache API are more reliable in secure contexts (though not strictly required for basic functionality).

### Performance Considerations
- The app makes heavy use of the Cache API and IndexedDB; ensure browsers support these (all modern browsers do).
- Large numbers of images may consume significant cache storage. The “delete all data” button helps manage this.
- The 1.2s delay between search queries is intentional; reducing it may result in HTTP 429 errors from Scryfall.

---

## Dependencies & External Resources

| Resource        | URL                                             | Purpose                   |
|-----------------|-------------------------------------------------|---------------------------|
| Quill CSS       | `https://cdn.quilljs.com/1.3.6/quill.snow.css` | Rich text editor styles   |
| Quill JS        | `https://cdn.quilljs.com/1.3.6/quill.js`        | Rich text editor library  |
| Scryfall API    | `https://api.scryfall.com`                      | Card data and images      |
| Google Fonts    | (via CSS `font-family` fallback)                | Typography                |

No other libraries or polyfills are used. The app is entirely vanilla JavaScript with modern ES6+ features (async/await, template literals, `const`/`let`, arrow functions, etc.).

---

## Summary

The Scryfall Researcher is a polished, feature‑rich, offline‑capable Magic: The Gathering card search tool built with careful attention to data caching, user experience, and API rate‑limit compliance. Its internal logic prioritizes predictability: every query is translated deterministically, every API response is cached, and every UI state transition is animated to keep the user informed. The codebase is a single, well‑structured IIFE that can be understood by any developer familiar with vanilla JavaScript and browser storage APIs.

For any modifications or deployment, refer to the detailed comments within the HTML itself and this architectural document.
```