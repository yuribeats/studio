#import "au_host.h"
#import <AudioUnit/AUCocoaUIView.h>
#import <objc/runtime.h>

OSType fourCharToOSType(const std::string &s) {
    if (s.size() < 4) return 0;
    return ((OSType)s[0] << 24) | ((OSType)s[1] << 16) |
           ((OSType)s[2] << 8)  | (OSType)s[3];
}

AUPluginInstance* auHostCreateInstance(const std::string &typeStr,
                                       const std::string &subtypeStr,
                                       const std::string &mfgStr) {
    AudioComponentDescription desc = {};
    desc.componentType = fourCharToOSType(typeStr);
    desc.componentSubType = fourCharToOSType(subtypeStr);
    desc.componentManufacturer = fourCharToOSType(mfgStr);
    desc.componentFlags = 0;
    desc.componentFlagsMask = 0;

    AudioComponent comp = AudioComponentFindNext(NULL, &desc);
    if (!comp) {
        NSLog(@"[AU_HOST] Component not found: %s/%s/%s",
              typeStr.c_str(), subtypeStr.c_str(), mfgStr.c_str());
        return nullptr;
    }

    AudioComponentInstance auInst = nullptr;
    OSStatus err = AudioComponentInstanceNew(comp, &auInst);
    if (err != noErr || !auInst) {
        NSLog(@"[AU_HOST] Failed to instantiate component: %d", (int)err);
        return nullptr;
    }

    // Set up a basic stereo format so Initialize succeeds
    AudioStreamBasicDescription streamFmt = {};
    streamFmt.mSampleRate = 44100.0;
    streamFmt.mFormatID = kAudioFormatLinearPCM;
    streamFmt.mFormatFlags = kAudioFormatFlagIsFloat |
                             kAudioFormatFlagIsPacked |
                             kAudioFormatFlagIsNonInterleaved;
    streamFmt.mBitsPerChannel = 32;
    streamFmt.mChannelsPerFrame = 2;
    streamFmt.mFramesPerPacket = 1;
    streamFmt.mBytesPerFrame = 4;
    streamFmt.mBytesPerPacket = 4;

    // Set stream format on input scope (bus 0)
    AudioUnitSetProperty(auInst, kAudioUnitProperty_StreamFormat,
                         kAudioUnitScope_Input, 0,
                         &streamFmt, sizeof(streamFmt));

    // Set stream format on output scope (bus 0)
    AudioUnitSetProperty(auInst, kAudioUnitProperty_StreamFormat,
                         kAudioUnitScope_Output, 0,
                         &streamFmt, sizeof(streamFmt));

    err = AudioUnitInitialize(auInst);
    if (err != noErr) {
        NSLog(@"[AU_HOST] AudioUnitInitialize failed: %d", (int)err);
        AudioComponentInstanceDispose(auInst);
        return nullptr;
    }

    AUPluginInstance *inst = new AUPluginInstance();
    inst->auInstance = auInst;
    inst->component = comp;
    inst->initialized = true;

    NSLog(@"[AU_HOST] Created instance: %s/%s/%s",
          typeStr.c_str(), subtypeStr.c_str(), mfgStr.c_str());

    return inst;
}

NSView* auHostGetEditorView(AUPluginInstance *inst) {
    if (!inst || !inst->auInstance) return nil;

    // Query for Cocoa UI
    UInt32 dataSize = 0;
    Boolean writable = false;
    OSStatus err = AudioUnitGetPropertyInfo(
        inst->auInstance,
        kAudioUnitProperty_CocoaUI,
        kAudioUnitScope_Global, 0,
        &dataSize, &writable);

    if (err != noErr || dataSize == 0) {
        NSLog(@"[AU_HOST] No CocoaUI property for this AU");
        return nil;
    }

    // Allocate buffer for the CocoaUI info
    AudioUnitCocoaViewInfo *viewInfo =
        (AudioUnitCocoaViewInfo *)malloc(dataSize);

    err = AudioUnitGetProperty(
        inst->auInstance,
        kAudioUnitProperty_CocoaUI,
        kAudioUnitScope_Global, 0,
        viewInfo, &dataSize);

    if (err != noErr) {
        NSLog(@"[AU_HOST] Failed to get CocoaUI: %d", (int)err);
        free(viewInfo);
        return nil;
    }

    // Load the view factory bundle
    CFURLRef bundleURL = viewInfo->mCocoaAUViewBundleLocation;
    NSString *factoryClassName =
        (__bridge NSString *)viewInfo->mCocoaAUViewClass[0];

    NSBundle *viewBundle = [NSBundle bundleWithURL:(__bridge NSURL *)bundleURL];
    if (!viewBundle) {
        NSLog(@"[AU_HOST] Failed to load view bundle");
        // Release CF objects
        CFRelease(bundleURL);
        CFRelease(viewInfo->mCocoaAUViewClass[0]);
        free(viewInfo);
        return nil;
    }

    [viewBundle load];

    Class factoryClass = [viewBundle classNamed:factoryClassName];
    if (!factoryClass) {
        NSLog(@"[AU_HOST] View factory class not found: %@", factoryClassName);
        CFRelease(bundleURL);
        CFRelease(viewInfo->mCocoaAUViewClass[0]);
        free(viewInfo);
        return nil;
    }

    // Instantiate the factory and get the view
    id factory = [[factoryClass alloc] init];
    if (!factory ||
        ![(NSObject *)factory respondsToSelector:@selector(uiViewForAudioUnit:withSize:)]) {
        NSLog(@"[AU_HOST] Factory doesn't respond to uiViewForAudioUnit:withSize:");
        CFRelease(bundleURL);
        CFRelease(viewInfo->mCocoaAUViewClass[0]);
        free(viewInfo);
        return nil;
    }

    NSView *view = [(id<AUCocoaUIBase>)factory uiViewForAudioUnit:inst->auInstance
                                                          withSize:NSMakeSize(600, 400)];

    // Release CF objects
    CFRelease(bundleURL);
    CFRelease(viewInfo->mCocoaAUViewClass[0]);
    free(viewInfo);

    if (!view) {
        NSLog(@"[AU_HOST] uiViewForAudioUnit returned nil");
        return nil;
    }

    NSLog(@"[AU_HOST] Got editor view: %@", view);
    return view;
}

void auHostDestroyInstance(AUPluginInstance *inst) {
    if (!inst) return;

    if (inst->editorWindow) {
        [inst->editorWindow close];
        inst->editorWindow = nil;
    }
    inst->editorView = nil;

    if (inst->auInstance) {
        if (inst->initialized) {
            AudioUnitUninitialize(inst->auInstance);
        }
        AudioComponentInstanceDispose(inst->auInstance);
        inst->auInstance = nullptr;
    }

    inst->initialized = false;
    NSLog(@"[AU_HOST] Destroyed instance %u", inst->instanceId);
}
