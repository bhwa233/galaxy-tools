# Embeds a plugin's icon and process name into a native executable.
#
# Task Manager and Explorer read a process's name (FileDescription) and icon
# from the executable's own resources; nothing can set them at spawn time.
# Each plugin declares them in <plugin>/native-resources.json:
#   { "icon": "assets/icon.ico", "processes": { "<file>.exe": "<description>" } }
#
# spark233_plugin_resources(<target> PLUGIN <plugin dir> FILE <file>.exe
#                           [UPSTREAM_RC <rc>] [REPLACE_SOURCES <regex>])
#   UPSTREAM_RC      keep an upstream resource script's other resources but drop
#                    its icon and version blocks; add the script to the target
#                    through this function instead of listing it directly.
#   REPLACE_SOURCES  remove target sources (e.g. an upstream version resource)
#                    whose paths match <regex>.
include_guard(GLOBAL)

function(spark233_plugin_resources target)
    cmake_parse_arguments(PARSE_ARGV 1 ARG "" "PLUGIN;FILE;UPSTREAM_RC;REPLACE_SOURCES" "")
    if(NOT ARG_PLUGIN OR NOT ARG_FILE)
        message(FATAL_ERROR "spark233_plugin_resources(${target}) needs PLUGIN and FILE")
    endif()
    get_filename_component(plugin "${ARG_PLUGIN}" ABSOLUTE)
    set(config "${plugin}/native-resources.json")
    file(READ "${config}" json)
    string(JSON icon_relative GET "${json}" icon)
    string(JSON description ERROR_VARIABLE missing GET "${json}" processes "${ARG_FILE}")
    if(missing)
        message(FATAL_ERROR "${config} does not name ${ARG_FILE}")
    endif()
    if(NOT description MATCHES "^[ -!#-~]+$")
        message(FATAL_ERROR "${config}: ${ARG_FILE} needs a printable ASCII description without quotes")
    endif()
    get_filename_component(icon "${plugin}/${icon_relative}" ABSOLUTE)
    if(NOT EXISTS "${icon}")
        message(FATAL_ERROR "${config}: icon is missing: ${icon}")
    endif()
    get_filename_component(internal_name "${ARG_FILE}" NAME_WE)

    set(body "")
    set(copyright "")
    set(rc_include "")
    if(ARG_UPSTREAM_RC)
        file(READ "${ARG_UPSTREAM_RC}" bom LIMIT 3 HEX)
        set(offset 0)
        if(bom STREQUAL "efbbbf")
            set(offset 3)
        endif()
        file(READ "${ARG_UPSTREAM_RC}" upstream OFFSET ${offset})
        if(upstream MATCHES "VALUE[ \t]+\"LegalCopyright\"[ \t]*,[ \t]*\"([^\"]*)\"")
            set(copyright "${CMAKE_MATCH_1}")
        endif()
        string(REGEX REPLACE "(^|\n)[ \t]*1[ \t]+ICON[^\n]*" "\\1" stripped "${upstream}")
        string(FIND "${stripped}" "VS_VERSION_INFO" version_at)
        if(stripped STREQUAL upstream OR version_at LESS 0)
            message(FATAL_ERROR "${ARG_UPSTREAM_RC} no longer has the expected icon and version blocks")
        endif()
        string(SUBSTRING "${stripped}" 0 ${version_at} body)
        # Relative resource paths in the upstream script resolve from its directory.
        get_filename_component(upstream_dir "${ARG_UPSTREAM_RC}" DIRECTORY)
        set(rc_include "${upstream_dir}")
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ARG_UPSTREAM_RC}")
    endif()
    if(copyright STREQUAL "")
        set(copyright_line "")
    else()
        set(copyright_line "            VALUE \"LegalCopyright\", \"${copyright}\"\n")
    endif()

    set(rc "${CMAKE_CURRENT_BINARY_DIR}/spark233-resources/${target}.rc")
    file(CONFIGURE OUTPUT "${rc}" @ONLY CONTENT [=[
#include <windows.h>
1 ICON "@icon@"
@body@
VS_VERSION_INFO VERSIONINFO
 FILEVERSION 1,0,0,0
 PRODUCTVERSION 1,0,0,0
 FILEFLAGSMASK 0x3fL
 FILEFLAGS 0x0L
 FILEOS VOS_NT_WINDOWS32
 FILETYPE VFT_APP
 FILESUBTYPE 0x0L
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "CompanyName", "spark233"
            VALUE "FileDescription", "@description@"
            VALUE "FileVersion", "1.0.0"
            VALUE "InternalName", "@internal_name@"
@copyright_line@            VALUE "OriginalFilename", "@ARG_FILE@"
            VALUE "ProductName", "spark233"
            VALUE "ProductVersion", "1.0.0"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x0409, 1200
    END
END
]=])
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${config}")
    set_source_files_properties("${rc}" PROPERTIES OBJECT_DEPENDS "${icon}")
    if(rc_include)
        set_source_files_properties("${rc}" PROPERTIES INCLUDE_DIRECTORIES "${rc_include}")
    endif()

    if(ARG_REPLACE_SOURCES)
        get_target_property(sources ${target} SOURCES)
        list(LENGTH sources before)
        list(FILTER sources EXCLUDE REGEX "${ARG_REPLACE_SOURCES}")
        list(LENGTH sources after)
        if(before EQUAL after)
            message(FATAL_ERROR "${target} has no source matching ${ARG_REPLACE_SOURCES}")
        endif()
        set_property(TARGET ${target} PROPERTY SOURCES "${sources}")
    endif()
    target_sources(${target} PRIVATE "${rc}")
endfunction()
