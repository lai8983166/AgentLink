# Bundled typography

The original web theme uses Space Grotesk and Space Mono. NSH bundles their regular and bold faces so typography does not depend on a remote font request. Chinese glyphs use Android's sans-serif fallback at the requested weight; appearance on vendor ROMs still needs device comparison.

Sources: Google Fonts `ofl/spacegrotesk/SpaceGrotesk[wght].ttf` and `ofl/spacemono/SpaceMono-Regular.ttf`, `SpaceMono-Bold.ttf`, retrieved 2026-11-09 from https://github.com/google/fonts. The accompanying SIL OFL licenses are retained here and shipped as third-party notices in the APK.

Space Grotesk static instances are generated with fontTools `instantiateVariableFont(font, {"wght": 400})` and `700`, retaining all glyphs. Static faces make weight selection explicit for the Android font registry. No screenshot text or session-specific font subsetting is used.
