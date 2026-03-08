Add icon files here before building:
  icon16.png   — 16x16px   (browser toolbar, favicon)
  icon48.png   — 48x48px   (extensions management page)
  icon128.png  — 128x128px (Chrome Web Store listing)

All three are referenced in manifest.json.
Any PNG exported from your logo works — just resize to the required dimensions.

 The EBUSY error means Electron is currently running and has
  that .asar file locked. Close the Electron app (check Task
  Manager for any electron.exe processes) then re-run npm        install.
                                                               
  Let me look at the current extension files to give you
  accurate next steps.

● Searched for 3 patterns, read 10 files (ctrl+o to expand)                                
● Good, now I have the full picture. Here's everything you need
   to do:                        
                                                               
  ---                                                          
  Fix: EBUSY npm install error                                                                                                
  Kill all electron.exe processes in Task Manager (or run      
  taskkill /f /im electron.exe in a terminal), then re-run npm 
  install.

  ---
  Steps to Load & Test the Chrome Extension

  1. Fix the OAuth Client ID (CRITICAL)

  The manifest.json currently has your Electron OAuth client ID
   (311947307992-...). Chrome extensions need a different OAuth
   2.0 client type.

  Go to https://console.cloud.google.com/apis/credentials:     
  - Create a new credential → OAuth 2.0 Client ID
  - Application type: Chrome Extension
  - You'll need the extension ID for this — get it in step 3   
  first, then come back and update manifest.json

  2. Create placeholder icons

  The build will fail without the icon files. Create 3 PNG     
  files (any solid-color image will do for testing):
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
  You can use Paint/any tool — just 16x16, 48x48, 128x128 solid
   squares.

  3. Install dependencies and build

  npm install
  npm run build

  This produces the dist/ folder with everything bundled.      

  4. Load the unpacked extension

  1. Open Chrome → go to chrome://extensions
  2. Enable Developer mode (top right toggle)
  3. Click Load unpacked
  4. Select the dist/ folder

  Chrome will assign a permanent extension ID (looks like      
  abcdefghijklmnop). Copy this ID.

  5. Fix the OAuth Client ID (complete step 1)

  Back in Google Cloud Console:
  - Edit the Chrome Extension OAuth client you created
  - Add your extension ID under Application ID:
  chrome-extension://YOUR_EXTENSION_ID
  - Copy the new Client ID
  - Update manifest.json line 28: replace the current client_id
   with the new one
  - Rebuild: npm run build
  - In chrome://extensions, click the refresh icon on FlowKit  

  6. Verify the sidebar opens

  - Navigate to a Google Sheet in Chrome
  - Click the FlowKit puzzle-piece icon in the toolbar
  - The sidebar should open on the right

  7. Sign in and test

  - Click "Sign In" → Google consent screen should appear      
  natively (no redirect, no localhost)
  - After auth, test Drive browsing, creating a flow sheet,    
  loading a tub

  ---
  What's Already Done (no changes needed)

  - manifest.json — MV3, permissions, side panel, content      
  script declaration
  - service-worker.js — full replacement for main.cjs +        
  auth.cjs + sheets-api.cjs
  - src/lib/bridge.js — window.flowkit shim so all Svelte      
  components work unchanged
  - src/content-script.js — block injection directly into      
  Sheets DOM (cleaner than Electron clipboard hack)
  - vite.config.js — multi-entry build outputting sidebar.html,
   service-worker.js, content-script.js
  - scripts/copy-static.js — copies manifest.json + icons/ into
   dist/

  The main blocker is the OAuth client ID — everything else is 
  wired up and ready to test once the icons exist and the build
   succeeds.



Updates on extension development: 

impressed with ability of the system, creating flows, 
All UI elements are working as intended, can create and add sheets
Can access flows within drive and open thme immediately 
can create flows instantly and load them 
Can add all different sypes of flows 
Can navigate and use the hotbar, 
etc -

Things that need work and need to be fixed

The UI organization is very clunky and weird 
The only space we have is the sidebar so everythin should be fitting with
the thought of having as much space as a phone
That means the pallete needs to be above everything on one level 
and then everything should stack underneath it
Fixing UI first is importnat, this ensures usability 
The other thing is only certain hotkeys and shortcuts remain viable
we need to switch out of ctrl K to open the bar, 
likely choosing something that is not used by chrome
Something not used  by sheetes or chrome, 
ctrl / still works fine to open the stuff etc, all good there
Next we need to make the ability to add block files more efficient viable
Currently I can add the 1AR file, but nothing is being parsed and no files are accessible nor are blokcs
This is likely because the file i snot being stored anywhere, hence parsing goes blank
We need to make sure that when we add a file, it is being stored in some cache, 
That way we can parse and make blocks to add in to it, 
Hence making all buttons and features work within the scope of a sidebar is essential, 
