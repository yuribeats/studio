cmake_minimum_required(VERSION 3.15)
project(au_host)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64")

# Build as Node.js N-API addon
include_directories(${CMAKE_JS_INC})

file(GLOB SOURCE_FILES
    "src/au_host.mm"
    "src/au_window.mm"
    "src/au_node_binding.mm"
)

add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

# macOS frameworks
target_link_libraries(${PROJECT_NAME}
    "-framework AudioToolbox"
    "-framework AudioUnit"
    "-framework CoreAudio"
    "-framework CoreFoundation"
    "-framework Cocoa"
)

# node-addon-api (no C++ exceptions)
execute_process(
    COMMAND node -p "require('node-addon-api').include"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/..
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_ADDON_API_DIR})
target_compile_definitions(${PROJECT_NAME} PRIVATE NAPI_DISABLE_CPP_EXCEPTIONS)

# Objective-C++ flags
set_source_files_properties(${SOURCE_FILES} PROPERTIES
    COMPILE_FLAGS "-fobjc-arc"
)
