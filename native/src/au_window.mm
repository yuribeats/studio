#import "au_window.h"
#import "au_host.h"
#import <objc/runtime.h>

// Delegate to handle window close and nil out references
@interface AUWindowDelegate : NSObject <NSWindowDelegate>
@property (assign) AUPluginInstance *instance;
@end

@implementation AUWindowDelegate

- (void)windowWillClose:(NSNotification *)notification {
    if (_instance) {
        _instance->editorWindow = nil;
        _instance->editorView = nil;
    }
}

@end

bool auWindowOpen(AUPluginInstance *inst, const char *title) {
    if (!inst) return false;

    // If window already open, bring it to front
    if (inst->editorWindow) {
        [inst->editorWindow makeKeyAndOrderFront:nil];
        return true;
    }

    // Get the editor view
    NSView *editorView = auHostGetEditorView(inst);
    if (!editorView) {
        NSLog(@"[AU_WINDOW] No editor view available — creating placeholder");
        // Create a simple placeholder view
        editorView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 400, 200)];
        editorView.wantsLayer = YES;
        editorView.layer.backgroundColor = [[NSColor blackColor] CGColor];

        NSTextField *label = [[NSTextField alloc] initWithFrame:NSMakeRect(20, 80, 360, 40)];
        label.stringValue = @"NO GUI AVAILABLE FOR THIS PLUGIN";
        label.font = [NSFont boldSystemFontOfSize:14];
        label.textColor = [NSColor whiteColor];
        label.backgroundColor = [NSColor clearColor];
        label.bordered = NO;
        label.editable = NO;
        label.selectable = NO;
        label.alignment = NSTextAlignmentCenter;
        [editorView addSubview:label];
    }

    // Determine window size from the view's frame
    NSRect viewFrame = editorView.frame;
    if (viewFrame.size.width < 100) viewFrame.size.width = 400;
    if (viewFrame.size.height < 50) viewFrame.size.height = 300;

    NSUInteger styleMask = NSWindowStyleMaskTitled |
                           NSWindowStyleMaskClosable |
                           NSWindowStyleMaskResizable;

    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:viewFrame
                  styleMask:styleMask
                    backing:NSBackingStoreBuffered
                      defer:NO];

    NSString *titleStr = [NSString stringWithUTF8String:(title ? title : "AU PLUGIN")];
    [window setTitle:[titleStr uppercaseString]];
    [window setContentView:editorView];
    [window setLevel:NSFloatingWindowLevel];
    [window setReleasedWhenClosed:NO];

    // Center on screen
    [window center];

    // Set delegate to track close
    AUWindowDelegate *delegate = [[AUWindowDelegate alloc] init];
    delegate.instance = inst;
    [window setDelegate:delegate];
    // Prevent delegate from being deallocated (associate with window)
    objc_setAssociatedObject(window, "delegate", delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

    [window makeKeyAndOrderFront:nil];

    inst->editorView = editorView;
    inst->editorWindow = window;

    NSLog(@"[AU_WINDOW] Opened window for instance %u: %s", inst->instanceId, title);
    return true;
}

void auWindowClose(AUPluginInstance *inst) {
    if (!inst) return;

    if (inst->editorWindow) {
        [inst->editorWindow close];
        inst->editorWindow = nil;
    }
    inst->editorView = nil;

    NSLog(@"[AU_WINDOW] Closed window for instance %u", inst->instanceId);
}
