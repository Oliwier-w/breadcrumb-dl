<p align="left">
  <img src="assets/icon.svg" width="64" height="64" alt="BreadcrumbDL Logo">
</p>

# BreadcrumbDL

A local-first Firefox extension that solves "download amnesia" by automatically recording webpage context, surrounding DOM text, and provenance metadata for every downloaded file. 

## Architecture

BreadcrumbDL operates locally using a clean background and content script architecture:
- **Content Script (`src/content/index.js`)**: Passively inspects click interactions and captures surrounding semantic elements (headings, container text, page titles) without injecting heavy third-party libraries.
- **Background Script (`src/background/index.js`)**: Listens to browser download events (`browser.downloads.onCreated`), binds the captured DOM context securely via session storage, and logs structured provenance metadata to local storage.
- **Sanitization Engine (`src/shared/sanitize.js`)**: Cleans and normalizes filenames safely, avoiding illegal characters and keeping clean naming conventions.

## Permissions Transparency

BreadcrumbDL requests only the absolute minimum permissions required for local archival:
- `downloads`: To track download events and capture file metadata.
- `storage`: To persist local download provenance history safely in your browser storage.
- `menus`: To offer **Download with Breadcrumb Name** in the link context menu.
- `<all_urls>`: To let the content script capture context around link clicks without opening the extension first.

## Development & Testing

The extension targets Firefox 142 or later and has no runtime dependencies.

```bash
npm test
npx web-ext lint
npx web-ext run
```
