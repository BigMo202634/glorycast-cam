GLORYCAST CAM
Phones on the church Wi-Fi become wireless cameras for OBS and vMix.
==========================================================================

WHAT YOU NEED
- The media computer (the one running OBS or vMix) and the phones on the SAME Wi-Fi.
  The media computer can be on a cable to the same router.
- Nothing to install on the phones. Any recent iPhone (Safari) or Android (Chrome).
  Android phones can also use the GloryCast Cam app for a smoother picture (see
  ANDROID APP below).
- Sound is not sent from the phones. Keep using the mixer into OBS.

START IT (WINDOWS)
1. Unzip the GloryCast-Cam folder somewhere you keep it (for example Documents).
2. Double-click "Start GloryCast Cam (Windows).bat".
3. The first time, Windows asks about the firewall for "Node.js". Tick BOTH Private
   and Public networks and click Allow. (Without this, phones cannot reach the computer.)
4. A black window opens (leave it open during service) and the GloryCast Cam page
   opens in your browser with a QR code.

ADD A PHONE
1. Connect the phone to the church Wi-Fi.
2. Scan the QR code on the GloryCast Cam page with the phone's camera.
3. FIRST TIME ONLY the phone says the connection is not private. It is your own
   computer on your own Wi-Fi, so continue:
     Android Chrome: Advanced, then "Proceed to ... (unsafe)"
     iPhone Safari:  Show Details, then "visit this website", then Visit Website
4. Type a camera name (Altar, Choir, Wide...), tap Start camera, allow the camera.
5. Hold the phone sideways on a tripod. Plug in a charger for long services.

ANDROID APP (SMOOTHER PICTURE)
- Android phones can use the GloryCast Cam app instead of Chrome. It keeps the frame
  rate steady in a dim church, uses the zoom lens when the phone has one, and keeps
  sending when the screen turns off or someone opens another app.
- Send "GloryCast-Cam.apk" from the "Android app" folder to the phone (WhatsApp or
  a USB cable), tap it and allow "Install unknown apps" when Android asks.
- Open GloryCast Cam on the phone, type a camera name, tap Start camera. It finds this
  computer by itself on the same Wi-Fi; if it doesn't, type the address shown on the
  GloryCast Cam page (for example 192.168.1.20).
- Everything else works the same: OBS links, the live light and the camera cards.
- A new app version installs over the old one; settings and the camera name stay.

PUT A PHONE IN OBS
1. On the GloryCast Cam page click "Copy OBS link" on the camera.
2. OBS: Sources +, Browser, name it (for example "Cam Altar").
3. Paste into URL. Width 1920, Height 1080.
4. Leave "Shutdown source when not visible" and "Refresh browser when scene becomes
   active" UNTICKED. If either is ticked, OBS restarts the camera at every switch.
5. OK. The phone picture appears. Put it in your scene under your overlays.
Same phone in more scenes: Sources +, Browser, "Add Existing", pick the camera.
     One Browser source per phone (a second one makes the phone send it twice).
Tip: you can set this up before Sunday with "Set up OBS before the phones arrive".
     Use the same camera name on the phone every week and it fills in by itself.

IF A CAMERA GOES BLACK OR SAYS "WAITING" WHEN YOU SWITCH
- In OBS, double-click that camera's Browser source and untick "Shutdown source when
  not visible" and "Refresh browser when scene becomes active". The camera card on the
  GloryCast Cam page warns when OBS keeps restarting a camera.
- "Waiting for the Altar camera" names the phone the source expects: that phone must
  be started with the same name.
- Use the camera phone only as a camera (not for GloryCast Switch or anything else).
- GloryCast Cam keeps the last picture for 10 seconds if a phone drops off the Wi-Fi,
  opens a restarted source on the phone's latest picture instead of black, and never
  puts the "Waiting" text on Program.

LIVE LIGHT ON THE PHONE (OBS)
- RED frame round the phone screen and "LIVE" = this camera is on Program. Hold steady.
- GREEN frame and "NOT LIVE" = the camera is in OBS but not live. Free to move,
  reframe or zoom.
- Works with GloryCast Switch (tap = live, Preview first and Program mode) and with
  OBS scenes and Studio Mode, because it follows what OBS puts on Program.
- No frame = the phone is not in OBS yet, or it lost the media computer.
- Just after OBS opens, a camera that is on screen in an OBS multiview or in Studio
  Mode Preview can show red until it has gone live once. Cameras that are not on
  screen anywhere show green straight away.

LOW BATTERY WARNING ON GLORYCAST SWITCH
- When a camera phone gets to 20% and is not charging, GloryCast Switch shows a
  warning across the top and a battery mark on that camera's channel, so the person
  switching can tell the camera person to plug in. It warns again in red at 10% and
  at 5%, and clears once the phone is charging.
- Works for Android phones (the GloryCast Cam app or Chrome). iPhones in Safari do
  not share their battery level.
- Nothing to set up: Switch finds the phones in OBS by itself while this window is open.

SMOOTH PICTURE
- Every camera card on the GloryCast Cam page shows the picture size and frames per
  second arriving in OBS, the codec, and how many frames the phone's camera makes.
- "Too dark for smooth motion": the phone's camera has slowed down to gather light,
  so moving shots look jumpy. Android phones do this in a browser (iPhones do not).
  Add light where the camera points. The phone shows the same message.
- "OBS is getting still pictures from this phone, not live video": OBS only gets one
  picture a second, like a slideshow. Put the phone and the computer on the same Wi-Fi,
  turn off any VPN, and on a Mac allow OBS in System Settings, Privacy & Security,
  Local Network, then restart OBS.
- "Sending a smaller picture to keep the motion smooth": the Wi-Fi is weak, so the
  phone sends a slightly smaller picture rather than dropping frames. It goes back
  to full size by itself when the Wi-Fi keeps up.
- "The picture froze ... times": the Wi-Fi is struggling. Move the phone closer to
  the router, or choose HD 720p on the phone.
- The small pictures on this page move at up to 30 frames a second, like the real
  thing. GloryCast Switch's channel pictures are snapshots taken from OBS, so they
  move in steps; OBS itself gets the full live picture.

PUT A PHONE IN VMIX
- Click "Copy vMix link", then vMix: Add Input, Web Browser, paste, size 1920 x 1080.
- vMix may be on another computer on the same network; the vMix link works from there.
- The live light on the phone does not work with vMix yet (the phone shows CONNECTED).

GOOD TO KNOW
- Picture: 4K, 1080p or 720p, at 24, 25, 30, 50 or 60 fps (chosen on the phone).
  The phone shows what it really gives: many phone browsers stop at 1080p or 30 fps.
  4K needs strong Wi-Fi (about 20 Mbps per phone) and an OBS source set to 3840 x 2160.
  Choose "HD 720p" if the Wi-Fi is weak.
- "Picture settings" on the phone: white balance (Auto, Indoor bulbs 3200K,
  Tube lights 4000K, Daylight 5500K, Cloudy 6500K, Kelvin slider, lock), exposure
  (brightness, lock, shutter, ISO), focus lock and torch. Under tube lights set the
  shutter to 1/50 or 1/100 to stop flicker. Android Chrome allows most of these;
  iPhone Safari allows few, and the panel says when a control is not available.
  The camera card on the GloryCast Cam page warns "Weak Wi-Fi" when pictures are lost.
- A dedicated Wi-Fi router just for media gives the smoothest pictures.
- Keep the camera page open and the screen on. If the phone locks or you switch apps,
  the picture stops; open the page again and it reconnects.
- Flip switches front/back camera.
- LENS: tap 24, 35, 50, 85, 105, 150 or 200mm at the bottom of the phone screen
  (24mm is the phone's normal lens). On an iPhone Pro the long settings use its zoom
  lens by themselves, so the picture stays sharp; on phones without a zoom lens they
  are a digital zoom and get softer. A phone shows only the sizes it can reach,
  and remembers the lens it was on.
- ZOOM in between: pinch the phone screen with two fingers.
- BRIGHTNESS: drag the sun line on the right of the screen up or down; double-tap it
  to reset. Uses the camera's exposure when the browser allows it (Android); on iPhone
  it brightens the picture itself, on the phone and in OBS.
- LANDSCAPE: the picture to OBS is always landscape and nothing is ever turned.
  Turn OFF the iPhone rotation lock (Control Center) and hold the phone sideways.
  If a phone is upright, OBS gets only the middle part (the phone shows which part).
- The address can change if the computer gets a new address from the router. Scan the new
  QR code; OBS links use "localhost" so they never change.
- No internet is needed. Nothing leaves your Wi-Fi.

MAC
- Install Node.js (LTS) from nodejs.org once, then open "Start GloryCast Cam (Mac).command".

Ports used: 7795 (this computer and OBS), 7796 (phones, secure), 7797 (the Android
app finds this computer).
