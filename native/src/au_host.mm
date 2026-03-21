#import "au_host.h"
#import <AudioUnit/AUCocoaUIView.h>
#import <CoreAudioKit/CoreAudioKit.h>
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

    NSLog(@"[AU_HOST] Looking for component: type=0x%08X sub=0x%08X mfg=0x%08X",
          (unsigned)desc.componentType, (unsigned)desc.componentSubType,
          (unsigned)desc.componentManufacturer);

    AudioComponent comp = AudioComponentFindNext(NULL, &desc);
    if (!comp) {
        NSLog(@"[AU_HOST] Component not found: %s/%s/%s",
              typeStr.c_str(), subtypeStr.c_str(), mfgStr.c_str());
        return nullptr;
    }

    CFStringRef compName = NULL;
    AudioComponentCopyName(comp, &compName);
    if (compName) {
        NSLog(@"[AU_HOST] Found component: %@", (__bridge NSString *)compName);
        CFRelease(compName);
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

    // Set max frames per slice (some AUs require this)
    UInt32 maxFrames = 8192;
    AudioUnitSetProperty(auInst, kAudioUnitProperty_MaximumFramesPerSlice,
                         kAudioUnitScope_Global, 0,
                         &maxFrames, sizeof(maxFrames));

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

    NSLog(@"[AU_HOST] Created instance: %s/%s/%s (initialized OK)",
          typeStr.c_str(), subtypeStr.c_str(), mfgStr.c_str());

    return inst;
}

NSView* auHostGetEditorView(AUPluginInstance *inst) {
    if (!inst || !inst->auInstance) return nil;

    NSView *view = nil;

    // Try CocoaUI first
    UInt32 dataSize = 0;
    Boolean writable = false;
    OSStatus err = AudioUnitGetPropertyInfo(
        inst->auInstance,
        kAudioUnitProperty_CocoaUI,
        kAudioUnitScope_Global, 0,
        &dataSize, &writable);

    if (err == noErr && dataSize > 0) {
        AudioUnitCocoaViewInfo *viewInfo =
            (AudioUnitCocoaViewInfo *)calloc(1, dataSize);

        err = AudioUnitGetProperty(
            inst->auInstance,
            kAudioUnitProperty_CocoaUI,
            kAudioUnitScope_Global, 0,
            viewInfo, &dataSize);

        if (err == noErr && viewInfo->mCocoaAUViewBundleLocation) {
            NSBundle *viewBundle = [NSBundle bundleWithURL:
                (__bridge NSURL *)viewInfo->mCocoaAUViewBundleLocation];

            if (viewBundle) {
                Class factoryClass = [viewBundle classNamed:
                    (__bridge NSString *)viewInfo->mCocoaAUViewClass[0]];

                if (factoryClass &&
                    [factoryClass conformsToProtocol:@protocol(AUCocoaUIBase)]) {
                    id<AUCocoaUIBase> factory = [[factoryClass alloc] init];
                    view = [factory uiViewForAudioUnit:inst->auInstance
                                              withSize:NSMakeSize(800, 500)];
                    NSLog(@"[AU_HOST] Got CocoaUI view: %@", view);
                }
            }

            // Release CF objects
            CFRelease(viewInfo->mCocoaAUViewBundleLocation);
            for (UInt32 i = 0; i < (dataSize - sizeof(CFURLRef)) / sizeof(CFStringRef); i++) {
                if (viewInfo->mCocoaAUViewClass[i]) {
                    CFRelease(viewInfo->mCocoaAUViewClass[i]);
                }
            }
        }
        free(viewInfo);
    } else {
        NSLog(@"[AU_HOST] No CocoaUI property (err=%d, size=%u)", (int)err, (unsigned)dataSize);
    }

    // Fallback: AUGenericView (from CoreAudioKit)
    if (!view) {
        NSLog(@"[AU_HOST] Using AUGenericView fallback");
        view = [[AUGenericView alloc] initWithAudioUnit:inst->auInstance];
    }

    if (!view) {
        NSLog(@"[AU_HOST] WARNING: Both CocoaUI and AUGenericView failed");
    }

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
