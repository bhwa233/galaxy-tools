cmake_minimum_required(VERSION 3.25)
project(spark233_search_bridge LANGUAGES C CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "spark233 search requires Windows and the MSVC Windows SDK toolchain")
endif()
if(NOT EXISTS "${SPARK233_PULSE_SOURCE}/CMakeLists.txt")
    message(FATAL_ERROR "Run scripts/native-search/build.ps1 to prepare the pinned, isolated Pulse source")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(PULSE_WITH_LUMATEXT OFF CACHE BOOL "No file-manager UI in the search package" FORCE)
set(PULSE_UPDATE_MANIFEST_URL "" CACHE STRING "Updates belong to the spark233 plugin host" FORCE)
set(PULSE_UPDATE_PUBLIC_KEY_HEX "" CACHE STRING "Updates belong to the spark233 plugin host" FORCE)
add_compile_options(/utf-8 /permissive- /W4 /EHsc)
add_compile_definitions(UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX
    _WIN32_WINNT=0x0603 WINVER=0x0603 _WIN32_IE=0x0A00 NTDDI_VERSION=NTDDI_WIN10_NI)

# Reuse the upstream dependency graph. EXCLUDE_FROM_ALL plus explicit targets
# avoids building or shipping the file manager and its UI/test executables.
add_subdirectory("${SPARK233_PULSE_SOURCE}" pulse EXCLUDE_FROM_ALL)

add_executable(spark233_search_probe probe.cpp
    "${SPARK233_PULSE_SOURCE}/src/index/content_search_client.cpp"
    "${SPARK233_PULSE_SOURCE}/src/index/content_search_session.cpp"
    "${SPARK233_PULSE_SOURCE}/src/index/content_result_store.cpp"
    "${SPARK233_PULSE_SOURCE}/src/index/content_configuration.cpp")
target_include_directories(spark233_search_probe PRIVATE "${SPARK233_PULSE_SOURCE}/src")
target_link_libraries(spark233_search_probe PRIVATE pulse_sqlite_core ole32 advapi32 user32)
add_dependencies(spark233_search_probe pulse_index)
add_executable(spark233_search search.cpp
    "${SPARK233_PULSE_SOURCE}/src/index/index_client.cpp"
    "${SPARK233_PULSE_SOURCE}/src/index/content_search_client.cpp"
    "${SPARK233_PULSE_SOURCE}/src/index/content_search_session.cpp"
    "${SPARK233_PULSE_SOURCE}/src/index/content_result_store.cpp"
    "${SPARK233_PULSE_SOURCE}/src/index/content_configuration.cpp")
set_target_properties(spark233_search PROPERTIES OUTPUT_NAME "spark233.Search")
target_include_directories(spark233_search PRIVATE "${SPARK233_PULSE_SOURCE}/src")
target_compile_definitions(spark233_search PRIVATE SPARK233_SERVICE_ONLY)
target_link_libraries(spark233_search PRIVATE pulse_sqlite_core ole32 advapi32 user32 shell32 uuid)
add_dependencies(spark233_search pulse_index)
add_custom_command(TARGET spark233_search_probe POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:spark233_search_probe>/licenses/Pulse"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SPARK233_PULSE_SOURCE}/LICENSE"
        "$<TARGET_FILE_DIR:spark233_search_probe>/licenses/Pulse/LICENSE"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SPARK233_PULSE_SOURCE}/third_party/ib-pinyin-cpp/LICENSE.txt"
        "$<TARGET_FILE_DIR:spark233_search_probe>/licenses/Pulse/ib-pinyin-cpp-MIT.txt"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SPARK233_PULSE_SOURCE}/third_party/ib-pinyin-cpp/README.pulse.txt"
        "$<TARGET_FILE_DIR:spark233_search_probe>/licenses/Pulse/ib-pinyin-cpp-provenance.txt")

# The upstream fixture checks real named-pipe impersonation and NTFS ACLs.
# Keep one authoritative permission-boundary check instead of duplicating it.
add_dependencies(pulse_index_caller_filter_test pulse_index)
