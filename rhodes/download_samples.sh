#!/bin/bash
cd "$(dirname "$0")/samples"
BASE="https://raw.githubusercontent.com/sfzinstruments/jlearman.jRhodes3c/master/jRhodes3c-looped-flac-sfz"

FILES=(
"As_029__F1_1109-stereo.flac"
"As_029__F1_279-stereo.flac"
"As_029__F1_361-stereo.flac"
"As_029__F1_431-stereo.flac"
"As_029__F1_51-stereo.flac"
"As_035__B1_1111-stereo.flac"
"As_035__B1_281-stereo.flac"
"As_035__B1_363-stereo.flac"
"As_035__B1_433-stereo.flac"
"As_035__B1_53-stereo.flac"
"As_040__E2_1113-stereo.flac"
"As_040__E2_283-stereo.flac"
"As_040__E2_365-stereo.flac"
"As_040__E2_435-stereo.flac"
"As_040__E2_55-stereo.flac"
"As_045__A2_1115-stereo.flac"
"As_045__A2_285-stereo.flac"
"As_045__A2_367-stereo.flac"
"As_045__A2_437-stereo.flac"
"As_045__A2_57-stereo.flac"
"As_050__D3_1117-stereo.flac"
"As_050__D3_287-stereo.flac"
"As_050__D3_369-stereo.flac"
"As_050__D3_439-stereo.flac"
"As_050__D3_59-stereo.flac"
"As_055__G3_1119-stereo.flac"
"As_055__G3_289-stereo.flac"
"As_055__G3_371-stereo.flac"
"As_055__G3_441-stereo.flac"
"As_055__G3_511-stereo.flac"
"As_059__B3_1121-stereo.flac"
"As_059__B3_291-stereo.flac"
"As_059__B3_373-stereo.flac"
"As_059__B3_443-stereo.flac"
"As_059__B3_513-stereo.flac"
"As_062__D4_1123-stereo.flac"
"As_062__D4_293-stereo.flac"
"As_062__D4_375-stereo.flac"
"As_062__D4_445-stereo.flac"
"As_062__D4_513-stereo.flac"
"As_065__F4_1125-stereo.flac"
"As_065__F4_295-stereo.flac"
"As_065__F4_377-stereo.flac"
"As_065__F4_447-stereo.flac"
"As_065__F4_517-stereo.flac"
"As_071__B4_1127-stereo.flac"
"As_071__B4_297-stereo.flac"
"As_071__B4_449-stereo.flac"
"As_071__B4_519-stereo.flac"
"As_076__E5_1129-stereo.flac"
"As_076__E5_299-stereo.flac"
"As_076__E5_451-stereo.flac"
"As_076__E5_521-stereo.flac"
"As_081__A5_2101-stereo.flac"
"As_081__A5_453-stereo.flac"
"As_081__A5_523-stereo.flac"
"As_086__D6_2103-stereo.flac"
"As_086__D6_455-stereo.flac"
"As_086__D6_525-stereo.flac"
"As_091__G6_2105-stereo.flac"
"As_091__G6_457-stereo.flac"
"As_091__G6_527-stereo.flac"
"As_096__C7_2107-stereo.flac"
"As_096__C7_459-stereo.flac"
"As_096__C7_529-stereo.flac"
)

count=0
total=${#FILES[@]}
for f in "${FILES[@]}"; do
    if [ ! -f "$f" ]; then
        curl -sL -o "$f" "$BASE/$f" &
    fi
    count=$((count + 1))
    if [ $((count % 10)) -eq 0 ]; then
        wait
        echo "Downloaded $count / $total"
    fi
done
wait
echo "Done. $(ls *.flac 2>/dev/null | wc -l | tr -d ' ') FLAC files in samples/"
