cmake_minimum_required(VERSION 3.25)
project(spark233_application_matcher LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "Application matching requires Windows/MSVC")
endif()
if(NOT EXISTS "${SPARK233_PULSE_SOURCE}/src/index/filename_pinyin.cpp")
  message(FATAL_ERROR "Supply the pinned Pulse source prepared by scripts/native-applications/build.ps1")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
add_executable(spark233_application_matcher matcher.cpp
  "${SPARK233_PULSE_SOURCE}/src/index/filename_pinyin.cpp"
  "${SPARK233_PULSE_SOURCE}/src/index/index_query.cpp"
  "${SPARK233_PULSE_SOURCE}/src/index/search_kinds.cpp")
set_target_properties(spark233_application_matcher PROPERTIES OUTPUT_NAME "spark233.ApplicationMatcher")
target_include_directories(spark233_application_matcher PRIVATE "${SPARK233_PULSE_SOURCE}/src")
target_compile_options(spark233_application_matcher PRIVATE /utf-8 /permissive- /W4 /EHsc)
target_compile_definitions(spark233_application_matcher PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
