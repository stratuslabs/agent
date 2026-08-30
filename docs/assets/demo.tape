# The hero demo GIF for the root README and the npm page.
#
# Regenerate from the repo root, after a build, with:
#
#   pnpm install --frozen-lockfile && pnpm build
#   vhs docs/assets/demo.tape
#
# Needs vhs, ttyd and ffmpeg on PATH (charmbracelet/vhs installs the first).
# Everything on screen is a real run of the CLI in this checkout against the
# offline demo provider — no keys, no sign-in, nothing credential-shaped.
# The agent's name, id, avatar palette and session ids are generated fresh on
# every take, so a regenerated GIF will not match this one frame for frame.
#
# Width and Height are sized to the output, not to taste: 103 columns keeps
# the `stratus agents` persona lines off a second row, and 29 rows is exactly
# the height of a `stratus run` transcript, which is the tallest beat here.
# Shrinking either starts wrapping or scrolling real output out of frame.

Output docs/assets/stratus-demo.gif

Require node
Require ttyd
Require ffmpeg

Set Shell bash
Set Width 1280
Set Height 760
Set FontSize 20
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set Framerate 24

# Setup, off camera: a throwaway home so the take starts from a clean
# install, and `stratus` pointed at the CLI built from this checkout so the
# commands on screen read the way they do after `npm install -g`.
Hide
Type "export REPO=$PWD DEMO_HOME=/tmp/stratus-demo" Enter
Type "rm -rf $DEMO_HOME && mkdir -p $DEMO_HOME && export HOME=$DEMO_HOME && cd $HOME" Enter
Type "alias stratus='node $REPO/packages/cli/dist/bin.js'" Enter
Type "PS1='> '" Enter
Type "clear" Enter
Show

# 1. Meet your agent: the guided create, with the name and persona prefilled.
Type "stratus agent new"
Sleep 500ms
Enter
Sleep 1800ms
Enter
Sleep 1400ms
Enter
Sleep 900ms
Enter
Sleep 2500ms

# 2. The whole agent loop: provider turn, tool call, tool result, reply.
Ctrl+L
Sleep 300ms
Type `stratus run "please use the echo tool"`
Sleep 500ms
Enter
Sleep 4s

# 3. Who is on the team, and the avatar palette that travels with them.
Ctrl+L
Sleep 300ms
Type "stratus agents"
Sleep 500ms
Enter
Sleep 4s
