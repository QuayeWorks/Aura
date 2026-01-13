#ifndef PLANE_SDF_H
#define PLANE_SDF_H

#include "signed_distance_field.h"

class JarPlaneSdf : public JarSignedDistanceField
{
    GDCLASS(JarPlaneSdf, JarSignedDistanceField);

  private:
    float _d;
    glm::vec3 _normal;

  public:
    JarPlaneSdf() : _normal(0.0f, 1.0f, 0.0f), _d(0.0f)
    {
    }
    void set_normal(const Vector3 &normal)
    {
        _normal = glm::vec3(normal.x, normal.y, normal.z);
        if(glm::length(_normal) <= 1.0e-6f)
        {
            _normal = glm::vec3(0.0f, 1.0f, 0.0f);
        }
        // _normal = glm::normalize(_normal);
    }
    Vector3 get_normal() const
    {
        return Vector3(_normal.x, _normal.y, _normal.z);
    }
    void set_d(float d)
    {
        _d = d;
    }
    float get_d() const
    {
        return _d;
    }

    virtual float distance(const glm::vec3 &pos) const override
    {
        return glm::dot(_normal, pos) + _d;
    }

  protected:
    static void _bind_methods()
    {
        ClassDB::bind_method(D_METHOD("set_normal", "normal"), &JarPlaneSdf::set_normal);
        ClassDB::bind_method(D_METHOD("get_normal"), &JarPlaneSdf::get_normal);
        ClassDB::bind_method(D_METHOD("set_d", "d"), &JarPlaneSdf::set_d);
        ClassDB::bind_method(D_METHOD("get_d"), &JarPlaneSdf::get_d);
        ADD_PROPERTY(PropertyInfo(Variant::VECTOR3, "normal"), "set_normal", "get_normal");
        ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "d"), "set_d", "get_d");
    }
};

#endif // PLANE_SDF_H
