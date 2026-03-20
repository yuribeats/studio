#pragma once

#import <AudioToolbox/AudioToolbox.h>
#import <AudioUnit/AudioUnit.h>
#import <CoreAudio/CoreAudio.h>
#import <Cocoa/Cocoa.h>
#include <string>
#include <cstdint>

// Converts a 4-char string like "aufx" to OSType
OSType fourCharToOSType(const std::string &s);

struct AUPluginInstance {
    uint32_t instanceId;
    AudioComponentInstance auInstance;
    AudioComponent component;
    NSView *editorView;
    NSWindow *editorWindow;
    bool initialized;

    AUPluginInstance()
        : instanceId(0), auInstance(nullptr), component(nullptr),
          editorView(nil), editorWindow(nil), initialized(false) {}
};

// Create an AU instance from type/subtype/mfg 4-char strings.
// Returns nullptr on failure.
AUPluginInstance* auHostCreateInstance(const std::string &typeStr,
                                       const std::string &subtypeStr,
                                       const std::string &mfgStr);

// Get the CocoaUI NSView for an AU instance.
// Returns nil if the plugin has no Cocoa UI.
NSView* auHostGetEditorView(AUPluginInstance *inst);

// Uninitialize and dispose the AU instance.
void auHostDestroyInstance(AUPluginInstance *inst);
