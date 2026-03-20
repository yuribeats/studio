#pragma once

#import <Cocoa/Cocoa.h>
#include <cstdint>

struct AUPluginInstance;

// Open a floating NSWindow containing the AU editor view.
// Returns true if the window was created successfully.
bool auWindowOpen(AUPluginInstance *inst, const char *title);

// Close and release the editor window for an instance.
void auWindowClose(AUPluginInstance *inst);
