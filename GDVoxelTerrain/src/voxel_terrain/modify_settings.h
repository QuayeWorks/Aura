#ifndef MODIFY_SETTINGS_H
#define MODIFY_SETTINGS_H

#include "signed_distance_field.h"
#include "bounds.h"
#include "sdf_operations.h"

struct ModifySettings
{
    public:
        Ref<JarSignedDistanceField> sdf;
        Bounds bounds;
        glm::vec3 position;
        SDF::Operation operation;
};

#endif // MODIFY_SETTINGS_H
