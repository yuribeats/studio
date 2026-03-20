#import <napi.h>
#import "au_host.h"
#import "au_window.h"
#include <unordered_map>
#include <mutex>
#include <atomic>

static std::unordered_map<uint32_t, AUPluginInstance*> g_instances;
static std::mutex g_mutex;
static std::atomic<uint32_t> g_nextId{1};

// ============================================
// createInstance(typeStr, subtypeStr, mfgStr) -> instanceId
// ============================================
Napi::Value CreateInstance(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 ||
        !info[0].IsString() || !info[1].IsString() || !info[2].IsString()) {
        Napi::TypeError::New(env, "Expected 3 string arguments: type, subtype, mfg")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string typeStr = info[0].As<Napi::String>().Utf8Value();
    std::string subtypeStr = info[1].As<Napi::String>().Utf8Value();
    std::string mfgStr = info[2].As<Napi::String>().Utf8Value();

    AUPluginInstance *inst = auHostCreateInstance(typeStr, subtypeStr, mfgStr);
    if (!inst) {
        Napi::Error::New(env, "Failed to create AU instance")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t id = g_nextId.fetch_add(1);
    inst->instanceId = id;

    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_instances[id] = inst;
    }

    return Napi::Number::New(env, id);
}

// ============================================
// openEditor(instanceId) -> bool
// ============================================
Napi::Value OpenEditor(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected instanceId (number)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t id = info[0].As<Napi::Number>().Uint32Value();

    // Optional title from second arg
    std::string title = "AU PLUGIN";
    if (info.Length() > 1 && info[1].IsString()) {
        title = info[1].As<Napi::String>().Utf8Value();
    }

    AUPluginInstance *inst = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        auto it = g_instances.find(id);
        if (it != g_instances.end()) inst = it->second;
    }

    if (!inst) {
        Napi::Error::New(env, "Instance not found")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    // GUI operations must happen on main thread.
    // In Electron, N-API calls from the main process are already on the main thread,
    // but dispatch to main queue to be safe for Cocoa.
    __block bool result = false;

    if ([NSThread isMainThread]) {
        result = auWindowOpen(inst, title.c_str());
    } else {
        dispatch_sync(dispatch_get_main_queue(), ^{
            result = auWindowOpen(inst, title.c_str());
        });
    }

    return Napi::Boolean::New(env, result);
}

// ============================================
// closeEditor(instanceId) -> void
// ============================================
Napi::Value CloseEditor(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected instanceId (number)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t id = info[0].As<Napi::Number>().Uint32Value();

    AUPluginInstance *inst = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        auto it = g_instances.find(id);
        if (it != g_instances.end()) inst = it->second;
    }

    if (!inst) {
        return env.Undefined();
    }

    if ([NSThread isMainThread]) {
        auWindowClose(inst);
    } else {
        dispatch_sync(dispatch_get_main_queue(), ^{
            auWindowClose(inst);
        });
    }

    return env.Undefined();
}

// ============================================
// destroyInstance(instanceId) -> void
// ============================================
Napi::Value DestroyInstance(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected instanceId (number)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t id = info[0].As<Napi::Number>().Uint32Value();

    AUPluginInstance *inst = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        auto it = g_instances.find(id);
        if (it != g_instances.end()) {
            inst = it->second;
            g_instances.erase(it);
        }
    }

    if (!inst) {
        return env.Undefined();
    }

    if ([NSThread isMainThread]) {
        auHostDestroyInstance(inst);
    } else {
        dispatch_sync(dispatch_get_main_queue(), ^{
            auHostDestroyInstance(inst);
        });
    }

    delete inst;
    return env.Undefined();
}

// ============================================
// getInstanceCount() -> number (for debugging)
// ============================================
Napi::Value GetInstanceCount(const Napi::CallbackInfo &info) {
    std::lock_guard<std::mutex> lock(g_mutex);
    return Napi::Number::New(info.Env(), (double)g_instances.size());
}

// ============================================
// MODULE INIT
// ============================================
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("createInstance",
                Napi::Function::New(env, CreateInstance));
    exports.Set("openEditor",
                Napi::Function::New(env, OpenEditor));
    exports.Set("closeEditor",
                Napi::Function::New(env, CloseEditor));
    exports.Set("destroyInstance",
                Napi::Function::New(env, DestroyInstance));
    exports.Set("getInstanceCount",
                Napi::Function::New(env, GetInstanceCount));
    return exports;
}

NODE_API_MODULE(au_host, Init)
